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
    },
    lastBufferedMonth: {
        llz: null,
        gp: null
    }
};

const MAX_POINTS = 600;
const RENDER_INTERVAL_MS = 250;
const LIVE_WINDOW_MS = 10000;
const CHART_WINDOW_MS = 5 * 60 * 1000;
const UAE_TIME_ZONE = 'Asia/Dubai';
const UAE_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
    timeZone: UAE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
});
const UAE_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
    timeZone: UAE_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
});
const UAE_YEAR_MONTH_FORMATTER = new Intl.DateTimeFormat('en-GB', {
    timeZone: UAE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit'
});
const PREFERRED_SIGNAL = "MON1 CL DDM (\u00b5A)";
const APP_ORIGIN = window.location.origin || `${window.location.protocol}//${window.location.host}`;
const API_BASE = `${APP_ORIGIN}/api`;

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
const lastAnalysisValue = document.getElementById('lastAnalysisValue');
const lastAnalysisDesc = document.getElementById('lastAnalysisDesc');
const userInfoLabel = document.querySelector('.user-info');

const alertsTableBody = document.getElementById('alertsTableBody');
const faultLogBody = document.getElementById('faultLogBody');
const faultTypeFilter = document.getElementById('faultTypeFilter');
const criticalFaults = document.getElementById('criticalFaults');

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
const viewAllAlertsBtn = document.getElementById('viewAllAlertsBtn');

let editingUserId = null;


function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function initialize() {
    initializeEventListeners();
    initializeCharts();
    loadMonths();
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

const FAKE_ILS_URL = `${APP_ORIGIN}/fake-ils`;

async function loadMonths() {
    const select = document.getElementById('monthFilterSelect');
    if (!select) return;
    try {
        const res = await fetch(`${FAKE_ILS_URL}/v1/months`);
        if (!res.ok) return;
        const data = await res.json();
        const monthNames = {
            '01': 'January', '02': 'February', '03': 'March',
            '04': 'April', '05': 'May', '06': 'June',
            '07': 'July', '08': 'August', '09': 'September',
            '10': 'October', '11': 'November', '12': 'December'
        };
        // Only keep the "All Months" default option, then append available months
        select.innerHTML = '<option value="">All Months</option>';
        (data.months || []).forEach(m => {
            const [year, month] = m.split('-');
            const label = `${monthNames[month] || month} ${year}`;
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = label;
            if (m === data.active) opt.selected = true;
            select.appendChild(opt);
        });
        // Show the current active month in the status message
        if (data.active) {
            const [y, mo] = data.active.split('-');
            const msg = document.getElementById('monthStatusMsg');
            if (msg) msg.textContent = `Streaming: ${monthNames[mo] || mo} ${y}`;
        }
    } catch (_) {
        // fake-ils API may not be running (e.g. in CI); silently skip
    }
}

async function applyMonth() {
    const select = document.getElementById('monthFilterSelect');
    const btn = document.getElementById('applyMonthBtn');
    const msg = document.getElementById('monthStatusMsg');
    if (!select || !btn) return;

    const month = select.value || null;
    btn.disabled = true;
    if (msg) { msg.textContent = 'Applying…'; msg.className = 'month-status-msg'; }

    try {
        const res = await fetch(`${FAKE_ILS_URL}/v1/month`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ month }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            if (msg) { msg.textContent = err.detail || 'Error'; msg.className = 'month-status-msg error'; }
            return;
        }
        const monthNames = {
            '01': 'January', '02': 'February', '03': 'March',
            '04': 'April', '05': 'May', '06': 'June',
            '07': 'July', '08': 'August', '09': 'September',
            '10': 'October', '11': 'November', '12': 'December'
        };
        if (msg) {
            if (month) {
                const [y, mo] = month.split('-');
                msg.textContent = `Now streaming: ${monthNames[mo] || mo} ${y}`;
            } else {
                msg.textContent = 'Now streaming: All Months';
            }
            msg.className = 'month-status-msg success';
            setTimeout(() => { if (msg) msg.className = 'month-status-msg'; }, 4000);
        }
    } catch (_) {
        if (msg) { msg.textContent = 'Fake-ILS API unreachable'; msg.className = 'month-status-msg error'; }
    } finally {
        btn.disabled = false;
    }
}

function initializeEventListeners() {
    loginForm.addEventListener('submit', handleLogin);
    logoutBtn.addEventListener('click', handleLogout);

    if (viewAllAlertsBtn) {
        viewAllAlertsBtn.addEventListener('click', () => {
            navigateToPage('fault-insights');
        });
    }

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

    const applyMonthBtn = document.getElementById('applyMonthBtn');
    if (applyMonthBtn) {
        applyMonthBtn.addEventListener('click', applyMonth);
    }

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
            } else if (action === 'delete') {
                handleDeleteUser(user);
            }
        });
    }

    initUploadPageEvents();
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

async function handleDeleteUser(user) {
    if (!user || !AppState.token) return;
    if (AppState.user && user.id === AppState.user.id) {
        window.alert('You cannot delete your own account');
        return;
    }

    const confirmed = window.confirm(`Delete user ${user.email}? This action cannot be undone.`);
    if (!confirmed) return;

    try {
        const response = await authFetch(`${API_BASE}/v1/users/${user.id}`, {
            method: 'DELETE'
        });
        if (!response.ok) {
            let detail = 'Failed to delete user';
            try {
                const payload = await response.json();
                if (payload && payload.detail) {
                    detail = payload.detail;
                }
            } catch (_) {
                // Ignore parse errors and use generic message.
            }
            throw new Error(detail);
        }
        await loadUsers();
    } catch (error) {
        window.alert(error.message || 'Failed to delete user');
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
                    <span>${escapeHtml(user.name || user.email)}</span>
                </div>
            </td>
            <td>${escapeHtml(user.email)}</td>
            <td><span class="badge ${roleBadge}">${user.role}</span></td>
            <td>${escapeHtml(user.department || '--')}</td>
            <td>${lastActive}</td>
            <td><span class="badge ${statusBadge}">${user.isActive ? 'Active' : 'Inactive'}</span></td>
            <td>
                <button class="btn-icon" data-action="edit" data-user-id="${user.id}" title="Edit user">✏️</button>
                <button class="btn-icon" data-action="delete" data-user-id="${user.id}" title="Delete user">🗑️</button>
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
                <div class="activity-text">${escapeHtml(actor)} ${escapeHtml(label)}</div>
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
    if (action === 'user.delete') return `deleted user${target}`;
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
            <td>${escapeHtml(timestamp)}</td>
            <td>${subsystem}</td>
            <td>${escapeHtml(faultType)}</td>
            <td>${confidence}</td>
            <td><span class="badge ${badgeClass}">${status}</span></td>
        `;
        alertsTableBody.appendChild(row);
    });
}

function parseTelemetryWindowFilename(filename) {
    if (!filename) return null;
    const match = String(filename).match(
        /^telemetry-([a-z0-9]+)-(.+?)-(\d{4}-\d{2}-\d{2}T.+)\.json$/i
    );
    if (!match) return null;

    const [, subsystem, startToken, endToken] = match;
    const decodeToken = (token) => {
        const parts = String(token).split('T');
        if (parts.length !== 2) return token;
        return `${parts[0]}T${parts[1].replace(/_/g, ':')}`;
    };

    return {
        subsystem: subsystem.toUpperCase(),
        startTs: decodeToken(startToken),
        endTs: decodeToken(endToken),
        raw: filename
    };
}

function formatHistoryFilename(item) {
    const raw = item?.filename || '';
    const parsed = parseTelemetryWindowFilename(raw);
    if (!parsed) {
        return {
            label: raw || '--',
            title: raw || ''
        };
    }

    const startLabel = formatTimestamp(parsed.startTs);
    const endLabel = formatTimeOnly(parsed.endTs);

    return {
        label: `Live ${parsed.subsystem} window ${startLabel} to ${endLabel} GST`,
        title: parsed.raw
    };
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
        const subsystem = (item.subsystem || '--').toUpperCase();
        const filenameInfo = formatHistoryFilename(item);
        const model = (item.metrics && item.metrics.dominant)
            ? `healthy(${item.metrics.dominant})`
            : (item.modelVersion || '--');
        const top = item.metrics?.top_signals?.join(', ');
        const titleAttr = top ? ` title="${top.replace(/"/g, '&quot;')}"` : '';
        row.innerHTML = `
            <td>${escapeHtml(item.dateStr || '--')}</td>
            <td title="${escapeHtml(filenameInfo.title)}">${escapeHtml(filenameInfo.label)}</td>
            <td>${item.recordCount ?? '--'}</td>
            <td>${subsystem}</td>
            <td><span class="badge ${badgeClass}">${item.prediction || 'NORMAL'}</span></td>
            <td>${model}</td>
            <td>${item.confidence || '--'}%</td>
        `;
        faultLogBody.appendChild(row);
    });
}

function updateFaultStats(items) {
    if (!Array.isArray(items) || items.length === 0) return;

    const total = items.length;
    const faults = items.filter(item => item.prediction === 'FAULT').length;
    const normals = items.filter(item => item.prediction === 'NORMAL').length;

    if (criticalFaults) criticalFaults.textContent = faults.toString();
    if (totalAnalyses) totalAnalyses.textContent = total.toString();
    if (normalOps) normalOps.textContent = normals.toString();
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
        else if (page === 'data-upload') pageTitle.textContent = 'Data Upload';
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
    const host = window.location.host || 'localhost';
    const wsUrl = `${protocol}://${host}/ws?subsystem=all&token=${encodeURIComponent(AppState.token)}`;

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
    const yearMonth = getYearMonthKey(ts);

    if (
        yearMonth &&
        AppState.lastBufferedMonth[subsystem] &&
        AppState.lastBufferedMonth[subsystem] !== yearMonth
    ) {
        resetSubsystemLiveState(subsystem);
    }
    if (yearMonth) {
        AppState.lastBufferedMonth[subsystem] = yearMonth;
    }

    AppState.lastMessageAt[subsystem] = Date.now();
    updateMeta(subsystem, ts, sourceId);

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

    if (selectedSignal[subsystem] && !availableSignals[subsystem].has(selectedSignal[subsystem])) {
        selectedSignal[subsystem] = null;
    }

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

function updateMeta(subsystem, ts, sourceId) {
    const meta = subsystem === 'llz' ? llzMeta : gpMeta;
    const timeLabel = formatTimestamp(ts);
    meta.textContent = `Last: ${timeLabel} • ${sourceId}`;
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
    return `${UAE_DATE_TIME_FORMATTER.format(parsed)} GST`;
}

function formatTimeOnly(ts) {
    const parsed = new Date(ts);
    if (Number.isNaN(parsed.getTime())) {
        return '--:--:--';
    }
    return UAE_TIME_FORMATTER.format(parsed);
}

function getYearMonthKey(ts) {
    const parsed = new Date(ts);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }
    const parts = UAE_YEAR_MONTH_FORMATTER.formatToParts(parsed);
    const year = parts.find(part => part.type === 'year')?.value;
    const month = parts.find(part => part.type === 'month')?.value;
    if (!year || !month) {
        return null;
    }
    return `${year}-${month}`;
}

function resetSubsystemLiveState(subsystem) {
    buffers[subsystem] = {};
    availableSignals[subsystem] = new Set();
    selectedSignal[subsystem] = null;

    const select = subsystem === 'llz' ? llzSignalSelect : gpSignalSelect;
    if (select) {
        select.innerHTML = '';
    }
}

window.addEventListener('beforeunload', () => {
    stopTelemetry();
    stopHistoryPolling();
    if (renderTimer) {
        clearInterval(renderTimer);
    }
});

document.addEventListener('DOMContentLoaded', initialize);

// --- File Upload Logic ---
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.style.padding = '1rem';
    toast.style.margin = '0.5rem';
    toast.style.borderRadius = '4px';
    toast.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';
    toast.style.color = '#fff';
    toast.style.background = type === 'error' ? '#EF4444' : type === 'success' ? '#10B981' : '#00B4D8';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function initUploadPageEvents() {
    const fileInput = document.getElementById('fileUploadInput');
    const dropzone = document.getElementById('uploadDropzone');
    const selectedFileName = document.getElementById('selectedFileName');
    const configCard = document.getElementById('uploadConfigCard');
    const cancelBtn = document.getElementById('cancelUploadBtn');
    const submitBtn = document.getElementById('submitUploadBtn');

    let currentSelectedFile = null;

    if (!fileInput || !dropzone) return;

    const handleFile = (file) => {
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.log')) {
            showToast('Please select a valid .log file', 'error');
            return;
        }
        currentSelectedFile = file;
        selectedFileName.textContent = file.name;
        configCard.style.display = 'block';
        document.getElementById('uploadResultCard').style.display = 'none';
    };

    fileInput.addEventListener('change', (e) => {
        handleFile(e.target.files[0]);
    });

    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = '#00B4D8';
        dropzone.style.backgroundColor = 'rgba(0, 180, 216, 0.05)';
    });

    dropzone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = 'var(--color-border)';
        dropzone.style.backgroundColor = 'var(--color-surface)';
    });

    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = 'var(--color-border)';
        dropzone.style.backgroundColor = 'var(--color-surface)';
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFile(e.dataTransfer.files[0]);
        }
    });

    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            currentSelectedFile = null;
            fileInput.value = '';
            configCard.style.display = 'none';
        });
    }

    if (submitBtn) {
        submitBtn.addEventListener('click', async () => {
            if (!currentSelectedFile) return;

            // UI updates
            submitBtn.disabled = true;
            cancelBtn.disabled = true;
            document.getElementById('uploadProgressContainer').style.display = 'flex';
            document.getElementById('uploadResultCard').style.display = 'none';

            try {
                const formData = new FormData();
                formData.append('file', currentSelectedFile);

                // Temporary override for authFetch headers to avoid passing global 'application/json' 
                // when we need FormData to set its own multipart/form-data boundary.
                const headers = { 'Authorization': `Bearer ${AppState.token}` };

                const response = await fetch(`${API_BASE}/v1/uploads`, {
                    method: 'POST',
                    headers: headers,
                    body: formData
                });

                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(err.detail || 'Failed to upload file');
                }

                const result = await response.json();
                renderUploadResult(result);
                loadHistory(); // Reload table after new successful upload
            } catch (error) {
                showToast(error.message || 'Error uploading file', 'error');
            } finally {
                submitBtn.disabled = false;
                cancelBtn.disabled = false;
                document.getElementById('uploadProgressContainer').style.display = 'none';
                currentSelectedFile = null;
                fileInput.value = '';
                configCard.style.display = 'none';
            }
        });
    }
}

function renderUploadResult(uploadResponse) {
    const resultCard = document.getElementById('uploadResultCard');
    const resIcon = document.getElementById('resIcon');
    const resPrediction = document.getElementById('resPrediction');
    const resConfidence = document.getElementById('resConfidence');
    const resRecords = document.getElementById('resRecords');
    const resModel = document.getElementById('resModel');
    const resIssuesContainer = document.getElementById('resIssuesContainer');
    const resIssuesList = document.getElementById('resIssuesList');

    if (!resultCard || !uploadResponse) return;

    const mlNode = uploadResponse.ml || {};
    const feats = uploadResponse.features || {};

    const pred = mlNode.prediction || 'NORMAL';
    let confVal = Number(mlNode.confidence || 0);
    if (confVal <= 1.0 && confVal > 0) confVal *= 100;
    const conf = isNaN(confVal) ? '--' : confVal.toFixed(1);
    const numRecords = feats.lines ?? '--';
    const dominantModel = mlNode.metrics ? (mlNode.metrics.dominant || mlNode.model_version) : mlNode.model_version;
    const modelStr = dominantModel || '--';
    const isFault = pred === 'FAULT';

    if (isFault) {
        resIcon.textContent = '⚠️';
        resIcon.className = 'fault-stat-icon critical';
        resIcon.style.color = '#EF4444';
        resPrediction.innerHTML = `<span class="badge badge-critical" style="font-size: 1.1em; background: rgba(239, 68, 68, 0.1); color: #EF4444;">FAULT</span>`;
    } else {
        resIcon.textContent = '✅';
        resIcon.className = 'fault-stat-icon success';
        resIcon.style.color = '#10B981';
        resPrediction.innerHTML = `<span class="badge badge-success" style="font-size: 1.1em; background: rgba(16, 185, 129, 0.1); color: #10B981;">NORMAL</span>`;
    }

    const subsystemStr = uploadResponse.subsystem || 'Unknown';
    resConfidence.textContent = conf;
    resRecords.textContent = numRecords;
    resModel.textContent = `Processing Pipeline: ${subsystemStr} Model (${modelStr})`;

    const issuesArr = mlNode.issues || [];
    if (issuesArr.length > 0) {
        resIssuesContainer.style.display = 'block';
        resIssuesList.innerHTML = issuesArr.map(ix => {
            return `<li style="margin-bottom: 0.5rem;">
                <strong>${escapeHtml(ix.type || 'Issue')}:</strong> ${escapeHtml(ix.description || '')} 
                <br/><small style="color: #00B4D8;">${escapeHtml(ix.recommendation || '')}</small>
            </li>`;
        }).join('');
    } else {
        resIssuesContainer.style.display = 'none';
        resIssuesList.innerHTML = '';
    }

    resultCard.style.display = 'block';
    showToast('Analysis complete', 'success');
}
