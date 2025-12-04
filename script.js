// 初始化地图
const map = L.map('map').setView([39.9042, 116.4074], 11); // 默认北京视角

// 使用 CartoDB 的亮色底图（看起来很干净）
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19
}).addTo(map);

let routingControl = null; // 存储路线控件
let markers = []; // 存储地图上的标记

// 核心入口函数
async function startPlanning() {
    const apiKey = document.getElementById('apiKey').value.trim();
    const startInput = document.getElementById('startPoint').value.trim();
    const endInput = document.getElementById('endPoint').value.trim();
    const waypointsInput = document.getElementById('waypoints').value.trim();

    if (!apiKey) return alert("请输入 API Key");
    if (!startInput || !endInput) return alert("起点和终点必填");

    showLoading(true, "AI 正在思考最优路线顺序...");
    clearMap();

    // 1. 处理输入数据
    const waypointsList = waypointsInput.split('\n').filter(line => line.trim() !== "");
    
    try {
        // 2. 请求 AI 进行逻辑排序 (TSP 问题)
        const sortedPlan = await askAIToSort(apiKey, startInput, endInput, waypointsList);
        
        // 更新 Markdown 面板显示交通建议
        document.getElementById('aiAnalysis').classList.remove('hidden');
        document.getElementById('markdownOutput').innerHTML = marked.parse(sortedPlan.analysis);

        showLoading(true, `正在获取 ${sortedPlan.sortedLocations.length} 个地点的地理坐标...`);

        // 3. 获取所有地点的经纬度 (Geocoding)
        // 顺序：起点 -> AI排好的途径点 -> 终点
        const allLocationsName = [startInput, ...sortedPlan.sortedWaypoints, endInput];
        const coordinates = await getCoordinatesBatch(allLocationsName);

        showLoading(true, "正在绘制地图路径...");

        // 4. 在地图上画线
        drawRouteOnMap(coordinates);

    } catch (error) {
        console.error(error);
        alert("规划失败：" + error.message);
    } finally {
        showLoading(false);
    }
}

// --- Step 1: 调用 LLM 进行排序 ---
async function askAIToSort(apiKey, start, end, midPoints) {
    const prompt = `
    我有一个旅行路线规划需求。
    起点：${start}
    终点：${end}
    途径点：${JSON.stringify(midPoints)}
    
    请根据地理位置，对“途径点”进行最优排序，使其形成一条从起点出发，经过所有途径点，最后到达终点的顺路路线（减少回头路）。
    
    请严格返回 JSON 格式，不要包含 Markdown 代码块标记（如 \`\`\`json）：
    {
        "sortedWaypoints": ["排好序的途径点1", "排好序的途径点2"...],
        "analysis": "Markdown格式的交通建议summary。请简要说明为什么要这样排序，并给出全程的大致交通建议（如建议打车还是地铁）。"
    }
    `;

    const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: "deepseek-chat",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2 // 低温度以保证 JSON 格式稳定
        })
    });

    if (!response.ok) throw new Error("AI API 请求失败");
    const data = await response.json();
    let content = data.choices[0].message.content;
    
    // 清理可能存在的 markdown 标记
    content = content.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(content);
}

// --- Step 2: 获取经纬度 (使用 OpenStreetMap Nominatim 免费 API) ---
async function getCoordinatesBatch(locationNames) {
    const coords = [];
    
    // 串行请求，避免触发 OSM 的速率限制 (Rate Limiting)
    for (const name of locationNames) {
        // 稍微延时一下，做一个礼貌的请求者
        await new Promise(r => setTimeout(r, 800)); 
        
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(name)}&limit=1`;
        const res = await fetch(url);
        const data = await res.json();
        
        if (data && data.length > 0) {
            // 注意：OSM 返回的是 [lat, lon]，Leaflet 需要 L.latLng(lat, lon)
            coords.push(L.latLng(data[0].lat, data[0].lon));
        } else {
            alert(`⚠️ 找不到地点：${name}，已自动跳过。`);
        }
    }
    return coords;
}

// --- Step 3: 地图绘图 ---
function drawRouteOnMap(latLngs) {
    if (latLngs.length < 2) return alert("有效坐标不足，无法绘制路线");

    // 使用 Leaflet Routing Machine 自动画线
    // 这里的 serviceUrl 默认是 OSRM 的公共演示服务器
    routingControl = L.Routing.control({
        waypoints: latLngs,
        routeWhileDragging: false,
        showAlternatives: false,
        fitSelectedRoutes: true, // 自动缩放地图以适应路线
        lineOptions: {
            styles: [{ color: '#4f46e5', opacity: 0.8, weight: 6 }]
        },
        createMarker: function(i, wp, nWps) {
            // 自定义标记样式
            let label = "";
            if (i === 0) label = "起";
            else if (i === nWps - 1) label = "终";
            else label = i;

            return L.marker(wp.latLng, {
                draggable: false,
                title: "Stop " + i
            }).bindPopup(`站点 ${i}: ${wp.latLng}`);
        }
    }).addTo(map);
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