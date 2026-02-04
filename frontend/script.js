const AppState = {
    isLoggedIn: false,
    currentPage: 'dashboard',
    ws: null,
    reconnectEnabled: false,
    reconnectTimer: null,
    connectionState: 'disconnected',
    dirty: false,
    lastMessageAt: {
        llz: null,
        gp: null
    }
};

const MAX_POINTS = 600;
const RENDER_INTERVAL_MS = 250;
const LIVE_WINDOW_MS = 10000;
const PREFERRED_SIGNAL = "MON1 CL DDM (\u00b5A)";

const buffers = {
    llz: {},
    gp: {}
};

const availableSignals = {
    llz: new Set(),
    gp: new Set()
};

const selectedSignal = {
    llz: null,
    gp: null
};

let llzChart = null;
let gpChart = null;
let renderTimer = null;

const loginScreen = document.getElementById('loginScreen');
const dashboardScreen = document.getElementById('dashboardScreen');
const loginForm = document.getElementById('loginForm');
const logoutBtn = document.getElementById('logoutBtn');

const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page');
const pageTitle = document.getElementById('pageTitle');

const statusDot = document.querySelector('.status-dot');
const systemStatusText = document.getElementById('systemStatusText');
const sidebarStateValue = document.getElementById('sidebarStateValue');
const sidebarStateIcon = document.querySelector('#sidebarSystemState .state-icon');
const systemBanner = document.getElementById('systemBanner');
const bannerTitle = document.getElementById('bannerTitle');
const bannerMessage = document.getElementById('bannerMessage');
const statusCard = document.getElementById('statusCard');
const systemStatusValue = document.getElementById('systemStatusValue');
const systemStatusDesc = document.getElementById('systemStatusDesc');

const coverageBadge = document.getElementById('coverageBadge');
const morningSegment = document.getElementById('morningSegment');
const afternoonSegment = document.getElementById('afternoonSegment');
const morningStatus = document.getElementById('morningStatus');
const afternoonStatus = document.getElementById('afternoonStatus');

const connectTelemetryBtn = document.getElementById('connectTelemetryBtn');

const llzSignalSelect = document.getElementById('llzSignalSelect');
const gpSignalSelect = document.getElementById('gpSignalSelect');
const llzMeta = document.getElementById('llzMeta');
const gpMeta = document.getElementById('gpMeta');
const llzLiveOverlay = document.getElementById('llzLiveOverlay');
const gpLiveOverlay = document.getElementById('gpLiveOverlay');

const prevDateBtn = document.getElementById('prevDateBtn');
const nextDateBtn = document.getElementById('nextDateBtn');
const currentDateDisplay = document.getElementById('currentDateDisplay');
const datePickerInput = document.getElementById('datePickerInput');

function initialize() {
    initializeEventListeners();
    initializeCharts();
    initializeDateNavigation();
    setConnectionState('disconnected');
    updateCoverageStatus();
    renderTimer = setInterval(() => {
        if (AppState.dirty) {
            updateCharts();
            AppState.dirty = false;
        }
    }, RENDER_INTERVAL_MS);
}

function initializeEventListeners() {
    loginForm.addEventListener('submit', handleLogin);
    logoutBtn.addEventListener('click', handleLogout);

    navItems.forEach(item => {
        item.addEventListener('click', (event) => {
            event.preventDefault();
            const page = item.dataset.page;
            if (page) {
                navigateToPage(page);
            }
        });
    });

    llzSignalSelect.addEventListener('change', () => {
        selectedSignal.llz = llzSignalSelect.value;
        updateCharts();
    });

    gpSignalSelect.addEventListener('change', () => {
        selectedSignal.gp = gpSignalSelect.value;
        updateCharts();
    });

    connectTelemetryBtn.addEventListener('click', () => {
        if (!AppState.isLoggedIn) return;
        reconnectTelemetry();
    });
}

function initializeDateNavigation() {
    if (currentDateDisplay) {
        currentDateDisplay.textContent = 'Live Telemetry';
    }
    if (prevDateBtn) prevDateBtn.disabled = true;
    if (nextDateBtn) nextDateBtn.disabled = true;
    if (datePickerInput) datePickerInput.disabled = true;
}

function handleLogin(event) {
    event.preventDefault();
    AppState.isLoggedIn = true;
    loginScreen.style.display = 'none';
    dashboardScreen.style.display = 'flex';
    navigateToPage('dashboard');
    startTelemetry();
}

function handleLogout() {
    AppState.isLoggedIn = false;
    stopTelemetry();
    loginScreen.style.display = 'flex';
    dashboardScreen.style.display = 'none';
}

function navigateToPage(page) {
    AppState.currentPage = page;
    pages.forEach(p => p.classList.remove('active'));
    navItems.forEach(item => item.classList.remove('active'));

    const pageMap = {
        dashboard: 'dashboardPage',
        'fault-insights': 'faultInsightsPage',
        'user-management': 'userManagementPage',
        'data-upload': 'dataUploadPage'
    };

    const targetId = pageMap[page] || 'dashboardPage';
    const targetPage = document.getElementById(targetId);
    if (targetPage) {
        targetPage.classList.add('active');
    }

    navItems.forEach(item => {
        if (item.dataset.page === page) {
            item.classList.add('active');
        }
    });

    if (pageTitle) {
        if (page === 'dashboard') pageTitle.textContent = 'Dashboard Overview';
        else if (page === 'fault-insights') pageTitle.textContent = 'Fault Insights';
        else if (page === 'user-management') pageTitle.textContent = 'User Management';
        else pageTitle.textContent = 'Dashboard Overview';
    }
}

function startTelemetry() {
    AppState.reconnectEnabled = true;
    connectTelemetry();
}

function stopTelemetry() {
    AppState.reconnectEnabled = false;
    if (AppState.reconnectTimer) {
        clearTimeout(AppState.reconnectTimer);
        AppState.reconnectTimer = null;
    }
    if (AppState.ws) {
        AppState.ws.close();
        AppState.ws = null;
    }
    setConnectionState('disconnected');
}

function reconnectTelemetry() {
    if (AppState.ws) {
        AppState.ws.close();
        AppState.ws = null;
    }
    connectTelemetry();
}

function connectTelemetry() {
    if (!AppState.reconnectEnabled) {
        return;
    }

    setConnectionState('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const host = window.location.hostname || 'localhost';
    const wsUrl = `${protocol}://${host}:8080/ws?subsystem=all`;

    try {
        AppState.ws = new WebSocket(wsUrl);
    } catch (error) {
        scheduleReconnect();
        return;
    }

    AppState.ws.onopen = () => {
        setConnectionState('connecting');
    };

    AppState.ws.onmessage = (event) => {
        handleTelemetryMessage(event.data);
    };

    AppState.ws.onclose = () => {
        setConnectionState('disconnected');
        scheduleReconnect();
    };

    AppState.ws.onerror = () => {
        setConnectionState('disconnected');
        if (AppState.ws) {
            AppState.ws.close();
        }
    };
}

function scheduleReconnect() {
    if (!AppState.reconnectEnabled) {
        return;
    }
    if (AppState.reconnectTimer) {
        clearTimeout(AppState.reconnectTimer);
    }
    AppState.reconnectTimer = setTimeout(() => {
        connectTelemetry();
    }, 1500);
}

function handleTelemetryMessage(payloadText) {
    let payload;
    try {
        payload = JSON.parse(payloadText);
    } catch (error) {
        return;
    }

    if (!payload || typeof payload !== 'object') {
        return;
    }

    window.__lastPayload = payload;

    const subsystem = payload.subsystem;
    if (subsystem !== 'llz' && subsystem !== 'gp') {
        return;
    }

    const signals = payload.signals || {};
    const ts = payload.ts || new Date().toISOString();
    const sourceId = payload.source_id || 'unknown';
    const seq = typeof payload.seq === 'number' ? payload.seq : null;

    AppState.lastMessageAt[subsystem] = Date.now();
    updateMeta(subsystem, ts, seq, sourceId);

    Object.keys(signals).forEach((key) => {
        availableSignals[subsystem].add(key);
        const value = signals[key];
        if (typeof value === 'number' && !Number.isNaN(value)) {
            if (!buffers[subsystem][key]) {
                buffers[subsystem][key] = [];
            }
            buffers[subsystem][key].push({
                t: ts,
                v: value
            });
            if (buffers[subsystem][key].length > MAX_POINTS) {
                buffers[subsystem][key].shift();
            }
        }
    });

    updateSignalOptions(subsystem);
    AppState.dirty = true;
    setConnectionState('live');
    updateCoverageStatus();
}

function updateSignalOptions(subsystem) {
    const select = subsystem === 'llz' ? llzSignalSelect : gpSignalSelect;
    const currentValue = selectedSignal[subsystem];

    const existing = new Set(Array.from(select.options).map(option => option.value));
    availableSignals[subsystem].forEach(signal => {
        if (!existing.has(signal)) {
            const option = document.createElement('option');
            option.value = signal;
            option.textContent = signal;
            select.appendChild(option);
        }
    });

    if (!selectedSignal[subsystem]) {
        if (availableSignals[subsystem].has(PREFERRED_SIGNAL)) {
            selectedSignal[subsystem] = PREFERRED_SIGNAL;
        } else {
            const firstSignal = select.options[0]?.value;
            if (firstSignal) {
                selectedSignal[subsystem] = firstSignal;
            }
        }
    }

    if (selectedSignal[subsystem]) {
        select.value = selectedSignal[subsystem];
    }

    if (currentValue && currentValue !== selectedSignal[subsystem]) {
        AppState.dirty = true;
    }
}

function updateMeta(subsystem, ts, seq, sourceId) {
    const meta = subsystem === 'llz' ? llzMeta : gpMeta;
    const timeLabel = formatTimestamp(ts);
    const seqLabel = seq !== null ? `seq ${seq}` : 'seq --';
    meta.textContent = `Last: ${timeLabel} • ${seqLabel} • ${sourceId}`;
}

function updateCharts() {
    updateSubsystemChart('llz', llzChart, llzLiveOverlay, llzSignalSelect);
    updateSubsystemChart('gp', gpChart, gpLiveOverlay, gpSignalSelect);
}

function updateSubsystemChart(subsystem, chart, overlay, select) {
    const signal = selectedSignal[subsystem];
    const series = signal ? buffers[subsystem][signal] || [] : [];

    if (!series.length) {
        overlay.style.display = 'flex';
        chart.data.labels = [];
        chart.data.datasets[0].data = [];
        chart.update('none');
        return;
    }

    overlay.style.display = 'none';
    const labels = series.map(point => formatTimeOnly(point.t));
    const data = series.map(point => point.v);

    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.data.datasets[0].label = signal || 'Signal';
    chart.update('none');
}

function initializeCharts() {
    llzChart = createLineChart('llzLiveChart', '#004E89');
    gpChart = createLineChart('gpLiveChart', '#00B4D8');
}

function createLineChart(canvasId, color) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Signal',
                    data: [],
                    borderColor: color,
                    backgroundColor: 'rgba(0, 180, 216, 0.08)',
                    fill: true,
                    tension: 0.25,
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                x: {
                    ticks: { maxTicksLimit: 6 }
                },
                y: {
                    ticks: { maxTicksLimit: 6 }
                }
            }
        }
    });
}

function setConnectionState(state) {
    AppState.connectionState = state;

    const config = {
        disconnected: {
            className: 'idle',
            statusText: 'Disconnected',
            sidebarText: 'Disconnected',
            bannerTitle: 'Telemetry Disconnected',
            bannerMessage: 'Reconnect to resume live telemetry streaming.',
            cardValue: 'Disconnected',
            cardDesc: 'Waiting for live data.'
        },
        connecting: {
            className: 'processing',
            statusText: 'Connecting...',
            sidebarText: 'Connecting...',
            bannerTitle: 'Connecting to Telemetry',
            bannerMessage: 'Establishing WebSocket connection to ingestion service.',
            cardValue: 'Connecting',
            cardDesc: 'Attempting to connect.'
        },
        live: {
            className: 'ok',
            statusText: 'Live',
            sidebarText: 'Live Telemetry',
            bannerTitle: 'Live Telemetry Mode',
            bannerMessage: 'Streaming LLZ/GP telemetry from ingestion service.',
            cardValue: 'Live',
            cardDesc: 'Receiving live data.'
        }
    };

    const current = config[state] || config.disconnected;

    if (statusDot) statusDot.className = `status-dot ${current.className}`;
    if (systemStatusText) systemStatusText.textContent = current.statusText;
    if (sidebarStateValue) sidebarStateValue.textContent = current.sidebarText;
    if (sidebarStateIcon) sidebarStateIcon.className = `state-icon ${current.className}`;

    if (systemBanner) systemBanner.className = `system-banner ${current.className}`;
    if (bannerTitle) bannerTitle.textContent = current.bannerTitle;
    if (bannerMessage) bannerMessage.textContent = current.bannerMessage;

    if (systemStatusValue) systemStatusValue.textContent = current.cardValue;
    if (systemStatusDesc) systemStatusDesc.textContent = current.cardDesc;
    if (statusCard) statusCard.className = `status-card ${current.className}`;
}

function updateCoverageStatus() {
    const now = Date.now();
    const llzLive = AppState.lastMessageAt.llz && (now - AppState.lastMessageAt.llz) < LIVE_WINDOW_MS;
    const gpLive = AppState.lastMessageAt.gp && (now - AppState.lastMessageAt.gp) < LIVE_WINDOW_MS;

    morningStatus.textContent = llzLive ? 'Live' : 'Waiting';
    afternoonStatus.textContent = gpLive ? 'Live' : 'Waiting';

    morningSegment.classList.toggle('uploaded', llzLive);
    afternoonSegment.classList.toggle('uploaded', gpLive);

    coverageBadge.classList.remove('empty', 'partial', 'full');

    if (llzLive && gpLive) {
        coverageBadge.textContent = 'Live';
        coverageBadge.classList.add('full');
    } else if (llzLive || gpLive) {
        coverageBadge.textContent = 'Partial';
        coverageBadge.classList.add('partial');
    } else {
        coverageBadge.textContent = 'Disconnected';
        coverageBadge.classList.add('empty');
    }
}

function formatTimestamp(ts) {
    const parsed = new Date(ts);
    if (Number.isNaN(parsed.getTime())) {
        return ts;
    }
    return parsed.toLocaleString();
}

function formatTimeOnly(ts) {
    const parsed = new Date(ts);
    if (Number.isNaN(parsed.getTime())) {
        return '--:--:--';
    }
    return parsed.toLocaleTimeString();
}

window.addEventListener('beforeunload', () => {
    stopTelemetry();
    if (renderTimer) {
        clearInterval(renderTimer);
    }
});

document.addEventListener('DOMContentLoaded', initialize);
