// 初始化地图
const map = L.map('map').setView([39.9042, 116.4074], 11);

// 加载地图底图
L.tileLayer('https://{s}[.basemaps.cartocdn.com/rastertiles/voyager/](https://.basemaps.cartocdn.com/rastertiles/voyager/){z}/{x}/{y}{r}.png', {
    attribution: '&copy; OSM &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 19
}).addTo(map);

let routingControl = null;
let markers = [];

async function startPlanning() {
    const apiKey = document.getElementById('apiKey').value.trim();
    const startInput = document.getElementById('startPoint').value.trim();
    const endInput = document.getElementById('endPoint').value.trim();
    const waypointsInput = document.getElementById('waypoints').value.trim();

    if (!apiKey) return alert("❌ 请输入 API Key");
    if (!startInput || !endInput) return alert("❌ 起点和终点必填");

    showLoading(true, "🤖 AI 正在思考最佳路线...");
    clearMap();

    const waypointsList = waypointsInput.split('\n').filter(line => line.trim() !== "");
    
    try {
        // --- 第一步：AI 排序 ---
        console.log("Step 1: Calling AI...");
        const sortedPlan = await askAIToSort(apiKey, startInput, endInput, waypointsList);
        console.log("AI Result:", sortedPlan);

        // 显示 AI 的文字建议
        document.getElementById('aiAnalysis').classList.remove('hidden');
        document.getElementById('markdownOutput').innerHTML = marked.parse(sortedPlan.analysis);

        // --- 第二步：获取坐标 ---
        const allLocationsName = [startInput, ...sortedPlan.sortedWaypoints, endInput];
        showLoading(true, `🌍 正在搜索 ${allLocationsName.length} 个地点的坐标 (请稍候)...`);
        
        console.log("Step 2: Geocoding locations...", allLocationsName);
        const coordinates = await getCoordinatesBatch(allLocationsName);

        if(coordinates.length < 2) {
            throw new Error("未能获取到足够的有效坐标，无法绘图。请检查地名是否正确。");
        }

        // --- 第三步：绘制路线 ---
        showLoading(true, "🚗 正在绘制道路轨迹...");
        console.log("Step 3: Drawing route...");
        drawRouteOnMap(coordinates);

    } catch (error) {
        console.error("Error details:", error);
        alert("🚫 出错了: " + error.message);
    } finally {
        showLoading(false);
    }
}

// --- 核心修复 1: 强力 JSON 解析器 ---
async function askAIToSort(apiKey, start, end, midPoints) {
    // 构造 Prompt
    const prompt = `
    任务：旅行商问题(TSP)路径优化。
    起点：${start}
    终点：${end}
    途径点：${JSON.stringify(midPoints)}
    
    要求：
    1. 请重新排列“途径点”的顺序，使其顺路。
    2. 返回纯 JSON 格式。
    
    返回格式示例：
    {
        "sortedWaypoints": ["地点A", "地点B"],
        "analysis": "这里写交通建议..."
    }
    `;

    try {
        const response = await fetch("[https://api.deepseek.com/chat/completions](https://api.deepseek.com/chat/completions)", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json", 
                "Authorization": `Bearer ${apiKey}` 
            },
            body: JSON.stringify({
                model: "deepseek-chat",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.1 // 越低越严谨
            })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(`AI API 请求失败 (${response.status}): ${errData.error?.message || '未知错误'}`);
        }

        const data = await response.json();
        const rawContent = data.choices[0].message.content;

        // 🔥 正则提取 JSON：不管 AI 是否加了 markdown 代码块，只提取 {} 之间的内容
        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error("AI 返回的数据格式无法识别，请重试。");
        }

        return JSON.parse(jsonMatch[0]);

    } catch (e) {
        throw new Error("AI 阶段失败: " + e.message);
    }
}

// --- 核心修复 2: 慢速搜索模式 (避免 429 错误) ---
async function getCoordinatesBatch(locationNames) {
    const coords = [];
    
    for (let i = 0; i < locationNames.length; i++) {
        const name = locationNames[i];
        
        // 更新 UI 提示进度
        showLoading(true, `🔍 正在搜索地点 (${i + 1}/${locationNames.length}): ${name}`);

        // 🔥 强制延迟 1.5秒！OpenStreetMap 免费接口要求每秒最多 1 次请求
        if (i > 0) await new Promise(r => setTimeout(r, 1500)); 
        
        try {
            const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(name)}&limit=1`;
            const res = await fetch(url);
            
            if (!res.ok) throw new Error("地图服务繁忙");
            
            const data = await res.json();
            
            if (data && data.length > 0) {
                console.log(`Found ${name}:`, data[0].lat, data[0].lon);
                coords.push(L.latLng(data[0].lat, data[0].lon));
            } else {
                console.warn(`未找到地点: ${name}`);
                // 如果找不到，就不加进去，避免画线报错
                alert(`⚠️ 地图上找不到 "${name}"，已自动跳过该点。建议尝试更官方的名称。`);
            }
        } catch (e) {
            console.error(`Search failed for ${name}`, e);
        }
    }
    return coords;
}

function drawRouteOnMap(latLngs) {
    if (routingControl) {
        map.removeControl(routingControl);
    }

    // 使用 Leaflet Routing Machine
    routingControl = L.Routing.control({
        waypoints: latLngs,
        routeWhileDragging: false,
        addWaypoints: false, // 禁止用户拖动增加点
        draggableWaypoints: false,
        fitSelectedRoutes: true,
        showAlternatives: false,
        lineOptions: {
            styles: [{ color: '#4f46e5', opacity: 0.8, weight: 6 }]
        },
        createMarker: function(i, wp, nWps) {
            // 自定义 Marker 图标
            return L.marker(wp.latLng, {
                title: `站点 ${i+1}`
            }).bindPopup(`站点 ${i+1}`);
        }
    }).addTo(map);

    // 监听路由错误（比如 OSRM 服务器挂了）
    routingControl.on('routingerror', function(e) {
        console.error("Routing Error:", e);
        alert("⚠️ 路线绘制失败：公共路由服务繁忙。但这不影响 AI 的排序结果。");
    });
}

function clearMap() {
    if (routingControl) {
        map.removeControl(routingControl);
        routingControl = null;
    }
    markers.forEach(m => map.removeLayer(m));
    markers = [];
}

function showLoading(show, text) {
    const el = document.getElementById('loadingOverlay');
    const txt = document.getElementById('loadingText');
    if (show) {
        el.classList.remove('hidden');
        txt.innerText = text;
    } else {
        el.classList.add('hidden');
    }
}