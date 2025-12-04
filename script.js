const map = L.map('map').setView([39.9042, 116.4074], 11);

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OSM &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 19
}).addTo(map);

let routingControl = null;
let markers = [];

// --- 配置表：不同服务商的 API 地址和模型名称 ---
const API_CONFIG = {
    'deepseek': {
        url: "https://api.deepseek.com/chat/completions",
        model: "deepseek-chat"
    },
    'siliconflow': {
        url: "https://api.siliconflow.cn/v1/chat/completions",
        // 硅基流动免费版通常叫这个名字，如果报错404，可尝试 'deepseek-chat'
        model: "deepseek-ai/DeepSeek-V3" 
    },
    'openai': {
        url: "https://api.openai.com/v1/chat/completions",
        model: "gpt-3.5-turbo"
    }
};

async function startPlanning() {
    const provider = document.getElementById('apiProvider').value;
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
        // Step 1: AI 排序
        const sortedPlan = await askAIToSort(provider, apiKey, startInput, endInput, waypointsList);
        
        document.getElementById('aiAnalysis').classList.remove('hidden');
        document.getElementById('markdownOutput').innerHTML = marked.parse(sortedPlan.analysis);

        // Step 2: 坐标搜索
        const allLocationsName = [startInput, ...sortedPlan.sortedWaypoints, endInput];
        showLoading(true, `🌍 正在搜索 ${allLocationsName.length} 个地点的坐标...`);
        
        const coordinates = await getCoordinatesBatch(allLocationsName);

        if(coordinates.length < 2) throw new Error("有效坐标不足，无法绘图");

        // Step 3: 画线
        showLoading(true, "🚗 正在绘制道路轨迹...");
        drawRouteOnMap(coordinates);

    } catch (error) {
        console.error(error);
        alert("🚫 出错了: " + error.message);
    } finally {
        showLoading(false);
    }
}

async function askAIToSort(provider, apiKey, start, end, midPoints) {
    const config = API_CONFIG[provider]; // 获取对应服务商的配置
    
    const prompt = `
    任务：旅行商问题(TSP)路径优化。
    起点：${start}
    终点：${end}
    途径点：${JSON.stringify(midPoints)}
    要求：重新排列“途径点”顺序，使其顺路。返回纯 JSON：
    { "sortedWaypoints": ["地点A", "地点B"], "analysis": "交通建议" }
    `;

    try {
        console.log(`正在请求 ${provider} ... URL: ${config.url}, Model: ${config.model}`);

        const response = await fetch(config.url, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json", 
                "Authorization": `Bearer ${apiKey}` 
            },
            body: JSON.stringify({
                model: config.model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.1,
                stream: false
            })
        });

        if (!response.ok) {
            // 尝试读取错误详情
            const errText = await response.text(); 
            // 如果返回的是 HTML，这里会被打印出来
            if (errText.trim().startsWith("<")) {
                throw new Error(`API 地址错误或服务商不可用。服务器返回了 HTML 网页而不是 JSON。请检查你选择的服务商是否正确。`);
            }
            throw new Error(`API 请求失败 (${response.status}): ${errText}`);
        }

        const data = await response.json();
        const rawContent = data.choices[0].message.content;
        
        // 正则提取 JSON
        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI 返回格式无法解析");
        
        return JSON.parse(jsonMatch[0]);

    } catch (e) {
        throw new Error(`AI 阶段失败: ${e.message}`);
    }
}

// --- 坐标搜索 & 绘图逻辑 (保持不变) ---
async function getCoordinatesBatch(locationNames) {
    const coords = [];
    for (let i = 0; i < locationNames.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 1200)); // 降速防止封禁
        
        const name = locationNames[i];
        showLoading(true, `🔍 搜索地点: ${name}`);
        
        try {
            const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(name)}&limit=1`;
            const res = await fetch(url);
            const data = await res.json();
            
            if (data && data.length > 0) {
                coords.push(L.latLng(data[0].lat, data[0].lon));
            } else {
                console.warn(`未找到: ${name}`);
            }
        } catch(e) { console.error(e); }
    }
    return coords;
}

function drawRouteOnMap(latLngs) {
    if (routingControl) map.removeControl(routingControl);
    routingControl = L.Routing.control({
        waypoints: latLngs,
        routeWhileDragging: false,
        addWaypoints: false,
        draggableWaypoints: false,
        showAlternatives: false,
        fitSelectedRoutes: true,
        lineOptions: { styles: [{ color: '#4f46e5', opacity: 0.8, weight: 6 }] }
    }).addTo(map);
}

function showLoading(show, text) {
    const el = document.getElementById('loadingOverlay');
    if (show) {
        el.classList.remove('hidden');
        document.getElementById('loadingText').innerText = text;
    } else {
        el.classList.add('hidden');
    }
}

function clearMap() {
    if (routingControl) {
        map.removeControl(routingControl);
        routingControl = null;
    }
    markers.forEach(m => map.removeLayer(m));
    markers = [];
}