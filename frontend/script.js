const AppState = {
    isLoggedIn: false,
    currentPage: 'dashboard',
    ws: null,
    reconnectEnabled: false,
    reconnectTimer: null,
    historyTimer: null,
    token: null,
    role: null,
    user: null,
    users: [],
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
const CHART_WINDOW_MS = 5 * 60 * 1000;
const PREFERRED_SIGNAL = "MON1 CL DDM (\u00b5A)";
const API_BASE = (() => {
    const host = window.location.hostname || 'localhost';
    return `${window.location.protocol}//${host}:8000`;
})();

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
let rulChart = null;
let faultChart = null;

const loginScreen = document.getElementById('loginScreen');
const dashboardScreen = document.getElementById('dashboardScreen');
const loginForm = document.getElementById('loginForm');
const logoutBtn = document.getElementById('logoutBtn');
const loginError = document.getElementById('loginError');

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
const rulChartOverlay = document.getElementById('rulChartOverlay');
const faultChartOverlay = document.getElementById('faultChartOverlay');
const rulValue = document.getElementById('rulValue');
const rulTrend = document.getElementById('rulTrend');
const rulDesc = document.getElementById('rulDesc');
const anomalyRate = document.getElementById('anomalyRate');
const anomalyTrend = document.getElementById('anomalyTrend');
const anomalyDesc = document.getElementById('anomalyDesc');
const lastAnalysisValue = document.getElementById('lastAnalysisValue');
const lastAnalysisDesc = document.getElementById('lastAnalysisDesc');
const userInfoLabel = document.querySelector('.user-info');

const prevDateBtn = document.getElementById('prevDateBtn');
const nextDateBtn = document.getElementById('nextDateBtn');
const currentDateDisplay = document.getElementById('currentDateDisplay');
const datePickerInput = document.getElementById('datePickerInput');
const alertsTableBody = document.getElementById('alertsTableBody');
const faultLogBody = document.getElementById('faultLogBody');
const faultTypeFilter = document.getElementById('faultTypeFilter');
const criticalFaults = document.getElementById('criticalFaults');
const warningFaults = document.getElementById('warningFaults');
const totalAnalyses = document.getElementById('totalAnalyses');
const normalOps = document.getElementById('normalOps');
const userTableBody = document.getElementById('userTableBody');
const totalUsers = document.getElementById('totalUsers');
const activeUsers = document.getElementById('activeUsers');
const adminUsers = document.getElementById('adminUsers');
const onlineUsers = document.getElementById('onlineUsers');
const addUserBtn = document.getElementById('addUserBtn');
const userModal = document.getElementById('userModal');
const userModalTitle = document.getElementById('userModalTitle');
const closeUserModal = document.getElementById('closeUserModal');
const cancelUserModal = document.getElementById('cancelUserModal');
const userForm = document.getElementById('userForm');
const userNameInput = document.getElementById('userName');
const userEmailInput = document.getElementById('userEmail');
const userRoleInput = document.getElementById('userRole');
const userDepartmentInput = document.getElementById('userDepartment');
const userPasswordInput = document.getElementById('userPassword');
const userResetPasswordInput = document.getElementById('userResetPassword');
const userActiveInput = document.getElementById('userActive');
const passwordGroup = document.getElementById('passwordGroup');
const resetGroup = document.getElementById('resetGroup');
const userFormError = document.getElementById('userFormError');
const activityLog = document.getElementById('activityLog');

let editingUserId = null;

function initialize() {
    initializeEventListeners();
    initializeCharts();
    initializeDateNavigation();
    setConnectionState('disconnected');
    updateCoverageStatus();
    setUserRoleVisibility();
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

    if (faultTypeFilter) {
        faultTypeFilter.addEventListener('change', () => {
            loadHistory();
        });
    }

    if (addUserBtn) {
        addUserBtn.addEventListener('click', () => {
            openUserModal('create');
        });
    }
    if (closeUserModal) {
        closeUserModal.addEventListener('click', closeUserModalWindow);
    }
    if (cancelUserModal) {
        cancelUserModal.addEventListener('click', closeUserModalWindow);
    }
    if (userModal) {
        userModal.addEventListener('click', (event) => {
            if (event.target === userModal) {
                closeUserModalWindow();
            }
        });
    }
    if (userForm) {
        userForm.addEventListener('submit', handleUserFormSubmit);
    }
    if (userTableBody) {
        userTableBody.addEventListener('click', (event) => {
            const target = event.target.closest('button[data-action]');
            if (!target) return;
            const action = target.dataset.action;
            const userId = Number(target.dataset.userId);
            if (!userId) return;
            const user = AppState.users ? AppState.users.find(u => u.id === userId) : null;
            if (action === 'edit') {
                openUserModal('edit', user);
            }
        });
    }
}

function initializeDateNavigation() {
    if (currentDateDisplay) {
        currentDateDisplay.textContent = 'Live Telemetry';
    }
    if (prevDateBtn) prevDateBtn.disabled = true;
    if (nextDateBtn) nextDateBtn.disabled = true;
    if (datePickerInput) datePickerInput.disabled = true;
}

async function authLogin(email, password) {
    if (!email || !password) {
        throw new Error('Enter email and password');
    }
    const response = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    });
    if (!response.ok) {
        throw new Error('Invalid credentials');
    }
    const data = await response.json();
    AppState.token = data.access_token;
    AppState.user = data.user || null;
    AppState.role = data.user ? data.user.role : null;
    if (userInfoLabel && data.user) {
        userInfoLabel.textContent = data.user.name || data.user.email || 'User';
    }
}

async function authFetch(url, options = {}) {
    if (!AppState.token) {
        throw new Error('Not authenticated');
    }
    const headers = options.headers ? { ...options.headers } : {};
    headers.Authorization = `Bearer ${AppState.token}`;
    return fetch(url, { ...options, headers });
}

function setUserRoleVisibility() {
    const userMgmtNav = document.querySelector('[data-page="user-management"]');
    const userPage = document.getElementById('userManagementPage');
    const isAdmin = AppState.role === 'admin';

    if (userMgmtNav) {
        userMgmtNav.style.display = isAdmin ? 'flex' : 'none';
    }
    if (addUserBtn) {
        addUserBtn.style.display = isAdmin ? 'inline-flex' : 'none';
    }
    if (!isAdmin && AppState.currentPage === 'user-management') {
        navigateToPage('dashboard');
    }
    if (userPage && !isAdmin) {
        userPage.classList.remove('active');
    }
}

function openUserModal(mode, user) {
    if (!userModal || !userForm) return;
    if (userFormError) userFormError.textContent = '';
    editingUserId = mode === 'edit' && user ? user.id : null;

    if (userModalTitle) {
        userModalTitle.textContent = mode === 'edit' ? 'Edit User' : 'Add User';
    }
    if (userNameInput) userNameInput.value = user?.name || '';
    if (userEmailInput) userEmailInput.value = user?.email || '';
    if (userRoleInput) userRoleInput.value = user?.role || 'engineer';
    if (userDepartmentInput) userDepartmentInput.value = user?.department || 'Operations';
    if (userActiveInput) userActiveInput.checked = user ? Boolean(user.isActive) : true;

    if (userPasswordInput) {
        userPasswordInput.value = '';
        userPasswordInput.required = mode !== 'edit';
    }
    if (userResetPasswordInput) {
        userResetPasswordInput.value = '';
    }

    if (passwordGroup) passwordGroup.classList.toggle('hidden', mode === 'edit');
    if (resetGroup) resetGroup.classList.toggle('hidden', mode !== 'edit');

    userModal.classList.remove('hidden');
    userModal.setAttribute('aria-hidden', 'false');
}

function closeUserModalWindow() {
    if (!userModal) return;
    userModal.classList.add('hidden');
    userModal.setAttribute('aria-hidden', 'true');
    editingUserId = null;
}

async function handleUserFormSubmit(event) {
    event.preventDefault();
    if (!AppState.token) return;

    const payload = {
        name: userNameInput ? userNameInput.value.trim() : '',
        email: userEmailInput ? userEmailInput.value.trim() : '',
        role: userRoleInput ? userRoleInput.value : 'engineer',
        department: userDepartmentInput ? userDepartmentInput.value.trim() || 'Operations' : 'Operations',
        isActive: userActiveInput ? userActiveInput.checked : true
    };

    try {
        if (!payload.name || !payload.email) {
            throw new Error('Name and email are required');
        }

        if (editingUserId) {
            const updateResponse = await authFetch(`${API_BASE}/v1/users/${editingUserId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!updateResponse.ok) {
                throw new Error('Failed to update user');
            }
            if (userResetPasswordInput && userResetPasswordInput.value.trim()) {
                const resetResponse = await authFetch(`${API_BASE}/v1/users/${editingUserId}/reset-password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ new_password: userResetPasswordInput.value })
                });
                if (!resetResponse.ok) {
                    throw new Error('Failed to reset password');
                }
            }
        } else {
            const password = userPasswordInput ? userPasswordInput.value : '';
            if (!password || password.length < 8) {
                throw new Error('Password must be at least 8 characters');
            }
            const createResponse = await authFetch(`${API_BASE}/v1/users`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, password })
            });
            if (!createResponse.ok) {
                const message = createResponse.status === 409 ? 'Email already exists' : 'Failed to create user';
                throw new Error(message);
            }
        }

        closeUserModalWindow();
        loadUsers();
        loadAudit();
    } catch (error) {
        if (userFormError) userFormError.textContent = error.message || 'Action failed';
    }
}

async function loadHistory() {
    try {
        const response = await authFetch(`${API_BASE}/v1/history?limit=100`);
        if (!response.ok) {
            throw new Error('Failed to load history');
        }
        const items = await response.json();
        renderAlerts(items);
        renderFaultLog(items);
        updateFaultStats(items);
        updateDashboardKPIs(items);
        updateOverviewCharts(items);
        if (AppState.role === 'admin') {
            loadUsers();
        }
    } catch (error) {
        // Keep UI placeholders if history is unavailable
    }
}

async function loadUsers() {
    if (!userTableBody || AppState.role !== 'admin') return;
    try {
        const response = await authFetch(`${API_BASE}/v1/users`);
        if (!response.ok) {
            throw new Error('Failed to load users');
        }
        const users = await response.json();
        AppState.users = Array.isArray(users) ? users : [];
        renderUsers(AppState.users);
        updateUserStats(AppState.users);
        loadAudit();
    } catch (error) {
        // Keep existing placeholders if user list fails
    }
}

function renderUsers(users) {
    if (!userTableBody) return;
    if (!Array.isArray(users) || users.length === 0) {
        userTableBody.innerHTML = '';
        return;
    }
    userTableBody.innerHTML = '';
    users.forEach(user => {
        const initials = (user.name || user.email || '--')
            .split(' ')
            .map(part => part[0])
            .join('')
            .slice(0, 2)
            .toUpperCase();
        const roleBadge = user.role === 'admin' ? 'badge-primary' : 'badge-secondary';
        const statusBadge = user.isActive ? 'badge-success' : 'badge-secondary';
        const lastActive = user.lastLoginAt ? formatTimestamp(user.lastLoginAt) : 'Never';

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>
                <div class="user-info-cell">
                    <div class="avatar">${initials}</div>
                    <span>${user.name || user.email}</span>
                </div>
            </td>
            <td>${user.email}</td>
            <td><span class="badge ${roleBadge}">${user.role}</span></td>
            <td>${user.department || '--'}</td>
            <td>${lastActive}</td>
            <td><span class="badge ${statusBadge}">${user.isActive ? 'Active' : 'Inactive'}</span></td>
            <td>
                <button class="btn-icon" data-action="edit" data-user-id="${user.id}" title="Edit user">✏️</button>
            </td>
        `;
        userTableBody.appendChild(row);
    });
}

function updateUserStats(users) {
    if (!Array.isArray(users)) return;
    const total = users.length;
    const active = users.filter(u => u.isActive).length;
    const admins = users.filter(u => u.role === 'admin').length;
    const online = AppState.user ? 1 : 0;

    if (totalUsers) totalUsers.textContent = total.toString();
    if (activeUsers) activeUsers.textContent = active.toString();
    if (adminUsers) adminUsers.textContent = admins.toString();
    if (onlineUsers) onlineUsers.textContent = online.toString();
}

async function loadAudit() {
    if (!activityLog || AppState.role !== 'admin') return;
    try {
        const response = await authFetch(`${API_BASE}/v1/audit?limit=10`);
        if (!response.ok) {
            throw new Error('Failed to load audit');
        }
        const logs = await response.json();
        renderAuditLogs(logs);
    } catch (error) {
        // Keep existing activity if audit fails
    }
}

function renderAuditLogs(logs) {
    if (!activityLog) return;
    if (!Array.isArray(logs) || logs.length === 0) {
        activityLog.innerHTML = '';
        return;
    }
    activityLog.innerHTML = '';
    logs.forEach(log => {
        const actor = log.actorName || log.actorEmail || 'System';
        const label = formatAuditAction(log.action, log.metadata || {});
        const time = formatTimestamp(log.createdAt || '');
        const item = document.createElement('div');
        item.className = 'activity-item';
        item.innerHTML = `
            <div class="activity-icon">🔑</div>
            <div class="activity-content">
                <div class="activity-text">${actor} ${label}</div>
                <div class="activity-time">${time}</div>
            </div>
        `;
        activityLog.appendChild(item);
    });
}

function formatAuditAction(action, metadata) {
    const target = metadata?.targetEmail ? ` ${metadata.targetEmail}` : '';
    if (action === 'login') return 'logged in';
    if (action === 'user.create') return `created user${target}`;
    if (action === 'user.update') return `updated user${target}`;
    if (action === 'user.reset_password') return `reset password for${target}`;
    return action.replace(/_/g, ' ');
}

function renderAlerts(items) {
    if (!alertsTableBody) return;
    if (!Array.isArray(items) || items.length === 0) {
        return;
    }

    alertsTableBody.innerHTML = '';
    items.slice(0, 8).forEach(item => {
        const timestamp = formatTimestamp(item.uploadedAt || item.dateStr || '');
        const subsystem = (item.subsystem || '--').toUpperCase();
        const faultType = item.faultType || (item.prediction === 'FAULT' ? 'fault' : 'none');
        const confidence = `${item.confidence || '--'}%`;
        const status = item.prediction || 'UNKNOWN';
        const badgeClass = statusBadgeClass(status);

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${timestamp}</td>
            <td>${subsystem}</td>
            <td>${faultType}</td>
            <td>${confidence}</td>
            <td><span class="badge ${badgeClass}">${status}</span></td>
        `;
        alertsTableBody.appendChild(row);
    });
}

function renderFaultLog(items) {
    if (!faultLogBody) return;
    if (!Array.isArray(items) || items.length === 0) {
        return;
    }

    const filter = faultTypeFilter ? faultTypeFilter.value : 'all';
    const filtered = items.filter(item => {
        if (filter === 'all') return true;
        return (item.prediction || '').toLowerCase() === filter;
    });

    faultLogBody.innerHTML = '';
    filtered.slice(0, 20).forEach(item => {
        const row = document.createElement('tr');
        const badgeClass = statusBadgeClass(item.prediction || 'NORMAL');
        row.innerHTML = `
            <td>${item.dateStr || '--'}</td>
            <td>${item.filename || '--'}</td>
            <td>${item.periodLabel || '--'}</td>
            <td>${item.recordCount ?? '--'}</td>
            <td><span class="badge ${badgeClass}">${item.prediction || 'NORMAL'}</span></td>
            <td>${item.confidence || '--'}%</td>
            <td>${item.rul ?? '--'}</td>
        `;
        faultLogBody.appendChild(row);
    });
}

function updateFaultStats(items) {
    if (!Array.isArray(items) || items.length === 0) return;

    const total = items.length;
    const faults = items.filter(item => item.prediction === 'FAULT').length;
    const warnings = items.filter(item => item.prediction === 'WARNING').length;
    const normals = items.filter(item => item.prediction === 'NORMAL').length;

    if (criticalFaults) criticalFaults.textContent = faults.toString();
    if (warningFaults) warningFaults.textContent = warnings.toString();
    if (totalAnalyses) totalAnalyses.textContent = total.toString();
    if (normalOps) normalOps.textContent = normals.toString();
}

function updateDashboardKPIs(items) {
    if (!Array.isArray(items) || items.length === 0) {
        if (anomalyRate) anomalyRate.textContent = '0.00';
        if (anomalyTrend) {
            anomalyTrend.textContent = '▼ 0.00%';
            anomalyTrend.className = 'trend-indicator down';
        }
        if (anomalyDesc) anomalyDesc.textContent = 'No data to analyze';
        if (rulValue) rulValue.textContent = '--';
        if (rulTrend) {
            rulTrend.textContent = '▲ 0%';
            rulTrend.className = 'trend-indicator up';
        }
        if (rulDesc) rulDesc.textContent = 'Requires data for prediction';
        if (lastAnalysisValue) lastAnalysisValue.textContent = 'Never';
        if (lastAnalysisDesc) lastAnalysisDesc.textContent = 'No analysis performed';
        return;
    }

    const latest = items[0];
    const previous = items[1];
    const latestAnomaly = normalizePercent(latest.anomalyRate ?? 0);
    const prevAnomaly = previous ? normalizePercent(previous.anomalyRate ?? 0) : latestAnomaly;
    const anomalyDelta = latestAnomaly - prevAnomaly;

    if (anomalyRate) anomalyRate.textContent = latestAnomaly.toFixed(2);
    if (anomalyTrend) setTrend(anomalyTrend, anomalyDelta);
    if (anomalyDesc) {
        anomalyDesc.textContent = latest.prediction
            ? `Latest: ${latest.prediction}`
            : 'Latest analysis available';
    }

    if (rulValue) rulValue.textContent = typeof latest.rul === 'number' ? latest.rul.toString() : '--';
    if (rulTrend) {
        const prevRul = previous && typeof previous.rul === 'number' ? previous.rul : latest.rul;
        const rulDelta = (latest.rul ?? 0) - (prevRul ?? 0);
        setTrend(rulTrend, rulDelta, true);
    }
    if (rulDesc) {
        const faultLabel = latest.faultType ? ` • ${latest.faultType}` : '';
        rulDesc.textContent = latest.prediction
            ? `Prediction: ${latest.prediction}${faultLabel}`
            : 'Prediction available';
    }

    if (lastAnalysisValue) lastAnalysisValue.textContent = formatTimestamp(latest.uploadedAt || latest.dateStr || '');
    if (lastAnalysisDesc) {
        const subsystem = latest.subsystem ? latest.subsystem.toUpperCase() : 'Unknown';
        const period = latest.periodLabel || latest.period || 'Window';
        lastAnalysisDesc.textContent = `${subsystem} • ${period}`;
    }
}

function updateOverviewCharts(items) {
    if (!Array.isArray(items) || items.length === 0) {
        if (rulChartOverlay) rulChartOverlay.style.display = 'flex';
        if (faultChartOverlay) faultChartOverlay.style.display = 'flex';
        if (rulChart) {
            rulChart.data.labels = [];
            rulChart.data.datasets[0].data = [];
            rulChart.update('none');
        }
        if (faultChart) {
            faultChart.data.labels = [];
            faultChart.data.datasets[0].data = [];
            faultChart.update('none');
        }
        return;
    }

    const ordered = items.slice(0, 30).reverse();
    const rulLabels = ordered.map(item => formatShortDate(item.uploadedAt || item.dateStr || ''));
    const rulData = ordered.map(item => (typeof item.rul === 'number' ? item.rul : 0));

    if (rulChart) {
        rulChart.data.labels = rulLabels;
        rulChart.data.datasets[0].data = rulData;
        rulChart.update('none');
    }
    if (rulChartOverlay) rulChartOverlay.style.display = rulData.length ? 'none' : 'flex';

    const faultsBySubsystem = {};
    items.forEach(item => {
        if (item.prediction !== 'FAULT') return;
        const key = (item.subsystem || 'unknown').toUpperCase();
        faultsBySubsystem[key] = (faultsBySubsystem[key] || 0) + 1;
    });

    const faultLabels = Object.keys(faultsBySubsystem);
    const faultData = faultLabels.map(label => faultsBySubsystem[label]);

    if (faultChart) {
        faultChart.data.labels = faultLabels;
        faultChart.data.datasets[0].data = faultData;
        faultChart.update('none');
    }
    if (faultChartOverlay) faultChartOverlay.style.display = faultData.length ? 'none' : 'flex';
}

function normalizePercent(value) {
    const num = typeof value === 'number' ? value : Number(value || 0);
    if (Number.isNaN(num)) return 0;
    return num <= 1 ? num * 100.0 : num;
}

function setTrend(element, delta, isAbsolute) {
    const value = Math.abs(delta);
    if (delta > 0) {
        element.className = 'trend-indicator up';
        element.textContent = `▲ ${value.toFixed(isAbsolute ? 0 : 2)}${isAbsolute ? '' : '%'}`;
    } else if (delta < 0) {
        element.className = 'trend-indicator down';
        element.textContent = `▼ ${value.toFixed(isAbsolute ? 0 : 2)}${isAbsolute ? '' : '%'}`;
    } else {
        element.className = 'trend-indicator';
        element.textContent = `• 0${isAbsolute ? '' : '.00%'} `;
    }
}

function formatShortDate(value) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return value || '--';
    }
    return parsed.toLocaleDateString();
}

function statusBadgeClass(status) {
    const normalized = (status || '').toUpperCase();
    if (normalized === 'FAULT') return 'badge-danger';
    if (normalized === 'WARNING') return 'badge-warning';
    return 'badge-success';
}

function handleLogin(event) {
    event.preventDefault();
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const email = emailInput ? emailInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';

    if (loginError) loginError.textContent = '';

    authLogin(email, password)
        .then(() => {
            AppState.isLoggedIn = true;
            loginScreen.style.display = 'none';
            dashboardScreen.style.display = 'flex';
            setUserRoleVisibility();
            navigateToPage('dashboard');
            startTelemetry();
            loadHistory();
            startHistoryPolling();
        })
        .catch((error) => {
            if (loginError) {
                loginError.textContent = error.message || 'Login failed';
            }
        });
}

function handleLogout() {
    AppState.isLoggedIn = false;
    AppState.token = null;
    AppState.role = null;
    AppState.user = null;
    AppState.users = [];
    stopTelemetry();
    stopHistoryPolling();
    loginScreen.style.display = 'flex';
    dashboardScreen.style.display = 'none';
    if (userInfoLabel) userInfoLabel.textContent = 'DANS Engineer';
}

function navigateToPage(page) {
    if (page === 'user-management' && AppState.role !== 'admin') {
        page = 'dashboard';
    }
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

function startHistoryPolling() {
    stopHistoryPolling();
    AppState.historyTimer = setInterval(() => {
        if (AppState.isLoggedIn) {
            loadHistory();
        }
    }, 15000);
}

function stopHistoryPolling() {
    if (AppState.historyTimer) {
        clearInterval(AppState.historyTimer);
        AppState.historyTimer = null;
    }
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
    if (!AppState.token) {
        setConnectionState('disconnected');
        return;
    }

    setConnectionState('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const host = window.location.hostname || 'localhost';
    const wsUrl = `${protocol}://${host}:8080/ws?subsystem=all&token=${encodeURIComponent(AppState.token)}`;

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

    const tsMillis = Date.parse(ts);
    const nowMillis = Number.isNaN(tsMillis) ? Date.now() : tsMillis;
    const cutoff = nowMillis - CHART_WINDOW_MS;

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
            buffers[subsystem][key] = buffers[subsystem][key].filter(point => {
                const pointMillis = Date.parse(point.t);
                if (Number.isNaN(pointMillis)) return true;
                return pointMillis >= cutoff;
            });
            if (buffers[subsystem][key].length > MAX_POINTS) {
                buffers[subsystem][key] = buffers[subsystem][key].slice(-MAX_POINTS);
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
    rulChart = createTrendChart('rulChart', '#16A34A');
    faultChart = createDoughnutChart('faultChart');
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

function createTrendChart(canvasId, color) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'RUL (hours)',
                    data: [],
                    borderColor: color,
                    backgroundColor: 'rgba(22, 163, 74, 0.08)',
                    fill: true,
                    tension: 0.25,
                    pointRadius: 2
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

function createDoughnutChart(canvasId) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    return new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: [],
            datasets: [
                {
                    data: [],
                    backgroundColor: ['#004E89', '#00B4D8', '#16A34A', '#F59E0B']
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: { position: 'bottom' }
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
    stopHistoryPolling();
    if (renderTimer) {
        clearInterval(renderTimer);
    }
});

document.addEventListener('DOMContentLoaded', initialize);
