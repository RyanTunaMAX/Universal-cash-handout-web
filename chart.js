// ====== 基本設定 ======
const CSV_URL = "atm.csv";
mapboxgl.accessToken = "pk.eyJ1IjoicnlhbnR1bmFtYXgiLCJhIjoiY21oY2M0OWFpMTJ3ODJtcHhiZzVncW5sciJ9.afMwqCnInzIZRbjBBZWuZA";

let raw = [], filtered = [];
let map, chartServiceByBank, chartAccessibleSummary, chartInstallTypeTreemap, chartLocationSunburst;

// ====== 初始化 ======
init();

function init() {
  Papa.parse(CSV_URL, {
    download: true, header: true, skipEmptyLines: true,
    complete: (res) => {
      raw = res.data.filter(r => r["座標緯度"] && r["座標經度"]);
      filtered = raw.slice();
      initFilters(raw);
      initMap();
      initServiceChart();
      initAccessibleChart();
      initInstallTypeTreemap();
      initLocationSunburst();
      applyFilters();

      window.addEventListener('resize', () => {
        chartServiceByBank && chartServiceByBank.resize({ animation: false });
        chartAccessibleSummary && chartAccessibleSummary.resize({ animation: false });
        map && map.resize();
      });
      setupResizeObserver();
    }
  });
}

// ====== ResizeObserver：監看左欄與地圖容器尺寸 ======
function setupResizeObserver() {
  const left = document.querySelector('.left');
  const mapEl = document.getElementById('map');
  if (!('ResizeObserver' in window) || !left || !mapEl) return;

  let raf = 0;
  const ro = new ResizeObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      chartServiceByBank && chartServiceByBank.resize({ animation: false });
      chartAccessibleSummary && chartAccessibleSummary.resize({ animation: false });
      chartInstallTypeTreemap && chartInstallTypeTreemap.resize({ animation: false });
      chartLocationSunburst && chartLocationSunburst.resize({ animation: false });
      map && map.resize();
      raf = 0;
    });
  });
  ro.observe(left);
  ro.observe(mapEl);
}

// ====== 篩選邏輯 ======
function initFilters(rows) {
  const citySel = document.getElementById('city');
  const bankSel = document.getElementById('bank');

  const cities = Array.from(new Set(rows.map(r => r["所屬縣市"]).filter(Boolean))).sort();
  citySel.innerHTML = `<option value="all">全部縣市</option>` + cities.map(c => `<option value="${c}">${c}</option>`).join('');
  rebuildBankOptions('all');

  citySel.onchange = () => { rebuildBankOptions(citySel.value); applyFilters(); };
  bankSel.onchange = applyFilters;
}

function rebuildBankOptions(city) {
  const bankSel = document.getElementById('bank');
  let scope = raw;
  if (city !== 'all') scope = raw.filter(r => r["所屬縣市"] === city);
  const banks = Array.from(new Set(scope.map(r => r["所屬銀行簡稱"]).filter(Boolean))).sort();
  bankSel.innerHTML = `<option value="all">全部銀行</option>` + banks.map(b => `<option value="${b}">${b}</option>`).join('');
}

function applyFilters() {
  const c = document.getElementById('city').value;
  const b = document.getElementById('bank').value;
  filtered = raw.filter(r => {
    const okCity = (c === 'all' || r["所屬縣市"] === c);
    const okBank = (b === 'all' || r["所屬銀行簡稱"] === b);
    return okCity && okBank;
  });
  updateKPIs();
  updateMap();
  updateServiceChart();
  updateAccessibleChart();
  updateInstallTypeTreemap();
  updateLocationSunburst();
}

function updateKPIs() {
  document.getElementById('kpiTotal').textContent = filtered.length.toLocaleString();
  const banks = new Set(filtered.map(r => r["所屬銀行簡稱"]).filter(Boolean));
  document.getElementById('kpiBanks').textContent = banks.size.toString();
}

// ====== 地圖 ======
function rowsToGeoJSON(rows) {
  return {
    type: "FeatureCollection",
    features: rows.map(r => ({
      type: "Feature",
      properties: {
        bank: r["所屬銀行簡稱"],
        place: r["裝設地點"],
        addr: r["地址"],
        city: r["所屬縣市"],
        town: r["鄉鎮縣市別"],
        tel: r["聯絡電話"] || ""
      },
      geometry: { type: "Point", coordinates: [+r["座標經度"], +r["座標緯度"]] }
    }))
  };
}

// ==== 地圖初始化（含：本島置中、圖層、容差點擊、複製座標、定位到我）====
function initMap(){
  map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/dark-v11',
    center: [121.0, 23.7],
    zoom: 5.6
  });

  // 基本導覽控件
  map.addControl(new mapboxgl.NavigationControl(), 'top-right');

  map.on('load', () => {
    // 只含「台灣本島」的外接邊界
    const BOUNDS = [[120.05, 21.8], [121.98, 25.35]];

    // 用 cameraForBounds 算出舒適鏡頭，再在此基礎上微放大
    const cam = map.cameraForBounds(BOUNDS, { padding: 80 });
    map.jumpTo({ center: cam.center, zoom: cam.zoom + 0.2 });

    // === 資料來源 ===
    map.addSource('atm', { type: 'geojson', data: rowsToGeoJSON(filtered) });

    // === 點圖層 ===
    map.addLayer({
      id: 'atm-points',
      type: 'circle',
      source: 'atm',
      paint: {
        'circle-color': '#4cc3ff',
        'circle-radius': 5,              // 稍微放大好點擊
        'circle-stroke-width': 1,
        'circle-stroke-color': '#0b1220'
      }
    });

    // ===== 互動：容差點擊（半徑 10px 方框），解決點擊偏移與難點到 =====
    map.on('click', (e) => {
      const box = [
        [e.point.x - 10, e.point.y - 10],
        [e.point.x + 10, e.point.y + 10]
      ];
      const feats = map.queryRenderedFeatures(box, { layers: ['atm-points'] });
      const f = feats[0];
      if (!f) return;

      const props  = f.properties || {};
      const coords = (f.geometry && f.geometry.coordinates)
        ? f.geometry.coordinates.slice()
        : [e.lngLat.lng, e.lngLat.lat];
      const [lng, lat] = coords;

      // 顯示名稱（優先裝設地點，其次銀行）
      const place = (props.place || props['裝設地點'] || '').trim();
      const bank  = (props.bank  || props['所屬銀行簡稱'] || '').trim();
      const nameLine = place || bank || '未知地點';

      const coordText = `${lat.toFixed(6)}, ${lng.toFixed(6)}`; // 緯度, 經度

      // 主題深藍字色
      const html = `
        <div style="min-width:200px;color:#0b1220">
          <div style="font-weight:700;margin-bottom:6px">${nameLine}</div>
          <div style="font-size:12px;opacity:.9;margin-bottom:6px">
            座標：<span id="coordVal">${coordText}</span>
          </div>
          <button id="copyCoordBtn" style="
            padding:6px 10px;border-radius:8px;border:1px solid #3b4a6b;
            background:#0f1730;color:#fff;cursor:pointer;font-size:12px
          ">複製座標</button>
          <span id="copyTip" style="font-size:12px;margin-left:8px;opacity:.9"></span>
        </div>
      `;

      new mapboxgl.Popup({ closeButton: true, closeOnClick: false, offset: 8 })
        .setLngLat(coords)
        .setHTML(html)
        .addTo(map);

      // 複製座標
      setTimeout(() => {
        const btn = document.getElementById('copyCoordBtn');
        const tip = document.getElementById('copyTip');
        if (!btn) return;
        btn.onclick = async () => {
          try {
            if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(coordText);
            } else {
              const ta = document.createElement('textarea');
              ta.value = coordText;
              document.body.appendChild(ta);
              ta.select(); document.execCommand('copy');
              document.body.removeChild(ta);
            }
            if (tip) { tip.textContent = '已複製！'; setTimeout(()=> tip.textContent='',1200); }
          } catch {
            if (tip) tip.textContent = '無法複製';
          }
        };
      }, 0);
    });

    // ===== 右上角「定位到我」按鈕（HTTPS/localhost 可用）=====
    const geo = new mapboxgl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: false,
      showAccuracyCircle: false,
      showUserHeading: true,
      fitBoundsOptions: { maxZoom: 12 } // 定位後縮放：數字越大越近
    });
    map.addControl(geo, 'top-right');
  });
}

function updateMap() {
  const src = map.getSource('atm');
  if (src) src.setData(rowsToGeoJSON(filtered));
}

// ====== 圖一：服務型態總值（柱狀） ======
function initServiceChart() {
  chartServiceByBank = echarts.init(document.getElementById('chartServiceByBank'));
  updateServiceChart();
}

function serviceLabel(code) {
  if (code === '9') return '24小時';
  if (code === 'E') return '9:00–22:00';
  if (code === 'N') return '9:00–15:30';
  return '其他';
}

// ====== 圖一：服務型態總值（柱狀） ======
function updateServiceChart() {
  if (!chartServiceByBank) return;

  // 統計各服務時段
  const buckets = { '24小時': 0, '9:00–22:00': 0, '9:00–15:30': 0 };
  filtered.forEach(r => {
    const code = (r["服務型態"] || '').trim();
    const label = code === '9' ? '24小時' : code === 'E' ? '9:00–22:00' : code === 'N' ? '9:00–15:30' : '其他';
    if (buckets[label] !== undefined) buckets[label]++;
  });

  // 移除數值為 0 的分類，避免出現「空柱」，剩一根柱時會自然置中
  const arr = Object.entries(buckets)
    .map(([name, val]) => ({ name, val }))
    .filter(d => d.val > 0);

  chartServiceByBank.setOption({
    backgroundColor: 'transparent',
    title: { text: '服務型態總值（依篩選）', left: 'center', top: 6, textStyle: { color: '#fff', fontSize: 14 } },
    tooltip: { trigger: 'axis' },
    grid: { left: '15%', right: '15%', top: 60, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category',
      data: arr.map(d => d.name),
      axisLabel: { color: '#bcd' },
      axisLine: { lineStyle: { color: '#445' } },
      axisTick: { alignWithLabel: true }
    },
    yAxis: { type: 'value', axisLabel: { color: '#bcd' } },
    series: [{
      type: 'bar',
      data: arr.map(d => d.val),
      barMaxWidth: 50,
      itemStyle: { borderRadius: [4, 4, 0, 0] }
    }]
  });
}

// ====== 圖二：無障礙服務總值（改為標準圓餅圖） ======
function initAccessibleChart() {
  chartAccessibleSummary = echarts.init(document.getElementById('chartAccessibleSummary'));
  updateAccessibleChart();
}

// ====== 圖二：無障礙服務總值（圓環） ======
function updateAccessibleChart() {
  if (!chartAccessibleSummary) return;

  let onlyWheel = 0, both = 0, none = 0;
  filtered.forEach(r => {
    const wheel = (r["符合輪椅使用且環境亦符合"] || '').trim() === 'V';
    const blind = (r["視障語音且環境亦符合"] || '').trim() === 'V';
    if (wheel && !blind) onlyWheel++;
    else if (wheel && blind) both++;
    else if (!wheel && !blind) none++;
  });

  // 移除 0 值分項（legend 也會自動不顯示）
  const data = [
    { value: onlyWheel, name: '輪椅友善' },
    { value: both, name: '輪椅+視障友善' },
    { value: none, name: '無障礙皆無' }
  ].filter(d => d.value > 0);

  chartAccessibleSummary.setOption({
    backgroundColor: 'transparent',
    title: {
      text: '無障礙服務總值（依篩選）',
      left: 'center',
      top: 0,
      textStyle: { color: '#fff', fontSize: 14 }
    },
    tooltip: { trigger: 'item' },
    legend: {
      // 往下貼近底部 → 與圖表距離變大
      bottom: 0,
      left: 'center',
      textStyle: { color: '#ccc' }
    },
    series: [{
      name: '無障礙服務',
      type: 'pie',
      // 圖表整體再往上移一點
      center: ['50%', '50%'],
      radius: ['42%', '66%'],
      avoidLabelOverlap: true,
      labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' },
      label: { show: true, color: '#fff', formatter: '{b}\n{d}%', fontSize: 12 },
      labelLine: { show: true, length: 8, length2: 12, maxSurfaceAngle: 80 },
      itemStyle: { borderRadius: 8, borderColor: '#0b1220', borderWidth: 2 },
      data
    }]
  });
}

// ====== 圖三：裝設型態 Treemap（1=銀行內、2=銀行外） ======
function initInstallTypeTreemap() {
  chartInstallTypeTreemap = echarts.init(document.getElementById('chartInstallTypeTreemap'));
  updateInstallTypeTreemap();
}

function updateInstallTypeTreemap() {
  if (!chartInstallTypeTreemap) return;

  // 統計：1=銀行內、2=銀行外
  let inside = 0, outside = 0;
  filtered.forEach(r => {
    const code = (r['裝設型態'] || '').trim();
    if (code === '1') inside++;
    else if (code === '2') outside++;
  });

  // 只保留兩筆分類，且移除 0 值
  const data = [
    { name: '銀行內', value: inside },
    { name: '銀行外', value: outside }
  ].filter(d => d.value > 0);

  chartInstallTypeTreemap.setOption({
    backgroundColor: 'transparent',
    title: { text: '裝設型態總值（依篩選）', left: 'center', top: 4, textStyle: { color: '#fff', fontSize: 14 } },
    tooltip: { formatter: p => `${p.name}：${p.value.toLocaleString()}` },
    series: [{
      type: 'treemap',
      roam: false,
      nodeClick: false,              // 只有兩塊，不需要點擊下鑽
      breadcrumb: { show: false },    // 關閉麵包屑
      label: {
        show: true,
        color: '#fff',
        formatter: p => `${p.name}\n${p.value.toLocaleString()}`
      },
      upperLabel: { show: false },
      itemStyle: { borderColor: '#0b1220', borderWidth: 2, gapWidth: 2 },
      data
    }]
  });
}

// ====== 圖四：裝設地點類別 Sunburst ======
function initLocationSunburst() {
  chartLocationSunburst = echarts.init(document.getElementById('chartLocationSunburst'));
  updateLocationSunburst();
}

function updateLocationSunburst() {
  if (!chartLocationSunburst) return;

  const el = document.getElementById('chartLocationSunburst');
  const bankSelVal = (document.getElementById('bank')?.value) || 'all';

  // ➊ 僅在「指定銀行」時顯示；否則隱藏並結束
  if (bankSelVal === 'all') {
    el.style.display = 'none';
    return;
  }

  // 代碼 → 類別名稱
  const catName = {
    'A': '火車站', 'B': '地方政府', 'H': '醫院', 'I': '學校',
    'C': '其他公務機關', 'D': '高鐵站', 'E': '長途客運站', 'F': '捷運站',
    'G': '機場', 'J': '大型賣場及百貨公司', 'K': '其他公共場所', 'L': '便利商店', 'O': '其他'
  };
  const subName = {
    'A1': '特等站', 'A2': '一等站', 'A3': '二等站', 'A4': '其他等級',
    'B1': '直轄市', 'B2': '縣市',
    'H1': '醫學中心', 'H2': '區域醫院', 'H3': '地區醫院', 'H4': '其他等級',
    'I1': '大專院校以上', 'I2': '高級中等學校', 'I3': '國中', 'I4': '小學',
    'C1': '其他公務機關', 'D1': '高鐵站', 'E1': '長途客運站', 'F1': '捷運站',
    'G1': '機場', 'J1': '大型賣場及百貨公司', 'K1': '其他公共場所', 'L1': '便利商店', 'O1': '其他'
  };

  // 統計各 code（欄位：裝設地點類別，已受外層 filtered 篩選影響）
  const counts = new Map(); // code -> count
  filtered.forEach(r => {
    const code = (r['裝設地點類別'] || '').trim(); // 例如 A1、B2、H3...
    if (!code) return;
    counts.set(code, (counts.get(code) || 0) + 1);
  });

  // 彙整：大類(cat) -> 次類陣列
  const catMap = new Map(); // cat -> Map(subCode -> count)
  counts.forEach((v, code) => {
    const cat = code[0];
    if (!catName[cat]) return;
    if (!catMap.has(cat)) catMap.set(cat, new Map());
    catMap.get(cat).set(code, v);
  });

  // ➋ 建資料：若某大類沒有次類、或只有單一次碼（且與母類型同義），就只顯示內圈，不畫外圈
  const data = Array.from(catMap.entries()).map(([cat, subMap]) => {
    const children = Array.from(subMap.entries())
      .map(([sub, v]) => ({ name: subName[sub] || sub, value: v, _code: sub }))
      .filter(d => d.value > 0)
      .sort((a, b) => b.value - a.value);

    const total = children.reduce((s, d) => s + d.value, 0);
    if (total <= 0) return null;

    // 判斷「是否需要外圈」
    // 規則：只有 1 個子碼，且該子碼名稱與大類等價（如 C1=其他公務機關、O1=其他…）→ 不畫外圈
    let needOuter = true;
    if (children.length === 1) {
      const only = children[0];
      const sameMeaning =
        only.name === (catName[cat] || '') ||
        // 多數單一子碼以 '1' 結尾（C1/D1/E1/F1/G1/J1/K1/L1/O1）
        /1$/.test(only._code);
      if (sameMeaning) needOuter = false;
    }

    if (!needOuter) {
      return { name: catName[cat], value: total }; // 只畫第一層
    }
    // 需要外圈：畫第一層 + 第二層
    return { name: catName[cat], value: total, children: children.map(({ _code, ...rest }) => rest) };
  })
    .filter(Boolean)
    .sort((a, b) => b.value - a.value);

  // 若整體沒有資料 → 隱藏圖表
  if (data.length === 0) {
    el.style.display = 'none';
    return;
  }

  // 有資料 → 顯示並繪圖
  el.style.display = 'block';

  chartLocationSunburst.setOption({
    backgroundColor: 'transparent',
    title: {
      text: '裝設地點類別總值（依篩選）',
      left: 'center',
      top: 6,
      textStyle: { color: '#fff', fontSize: 14 }
    },
    tooltip: {
      formatter: p => `${p.treePathInfo.map(t => t.name).slice(1).join(' / ')}：${p.value.toLocaleString()}`
    },
    series: [{
      type: 'sunburst',
      radius: ['18%', '78%'],
      sort: undefined,
      emphasis: { focus: 'ancestor' },
      data,
      label: {
        color: '#fff',                // 🔸改成純白字
        textBorderColor: 'transparent', // 🔸去除白邊框
        textBorderWidth: 0,
        fontWeight: 500,
        formatter: function (param) {
          const depth = param.treePathInfo.length;
          if (depth === 2 || depth === 3) return param.name || '';
          return '';
        }
      },
      levels: [
        {}, // root
        {   // 第一層（大類）→ Treemap 的藍色
          itemStyle: { color: '#5b74d6' },
          label: { rotate: 'radial' }
        },
        {   // 第二層（次類）→ Treemap 的綠色
          itemStyle: { color: '#88c96a' },
          label: { rotate: 'tangential' }
        }
      ]
    }]
  });

  // 若剛從隱藏→顯示，補一次 resize
  chartLocationSunburst.resize({ animation: false });
}

