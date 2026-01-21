/**
 * DANS ILS Predictive Maintenance Dashboard
 * Senior Design Project - Simulation System
 * 
 * This system simulates the end-to-end workflow of:
 * 1. Multi-file upload by DANS engineer
 * 2. Backend API processing with day coverage detection (a/b files)
 * 3. ML inference (simulated with rule-based logic)
 * 4. Persistent data storage with date-based navigation
 * 5. Frontend status updates
 * 
 * Architecture is designed to be scalable for future AWS ML integration
 */

// ============================================
// APPLICATION STATE MANAGEMENT
// ============================================
const AppState = {
    isLoggedIn: false,
    currentPage: 'dashboard',
    
    // System state
    systemState: 'idle', // idle, processing, ok, warning, fault
    lastAnalysis: null,
    
    // Date navigation
    selectedDate: new Date(),
    minHistoryDate: null,
    availableDates: [],
    history: [],
    
    // Current analysis data
    currentFiles: [], // Array of selected files
    currentData: null,
    predictions: null,
    
    // Storage keys
    STORAGE_KEY: 'dans_ils_data'
};

// ============================================
// DATA PERSISTENCE (Simulates Database)
// Note: In production, this would be AWS DynamoDB
// ============================================
const DataStore = {
    /**
     * Get all stored data
     */
    getAll() {
        try {
            const data = localStorage.getItem(AppState.STORAGE_KEY);
            return data ? JSON.parse(data) : { days: {}, uploadHistory: [] };
        } catch (e) {
            console.error('Error reading from localStorage:', e);
            return { days: {}, uploadHistory: [] };
        }
    },
    
    /**
     * Save all data
     */
    saveAll(data) {
        try {
            localStorage.setItem(AppState.STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            console.error('Error writing to localStorage:', e);
        }
    },
    
    /**
     * Get data for a specific date
     */
    getDateData(dateStr) {
        const data = this.getAll();
        return data.days[dateStr] || { morning: null, afternoon: null, combined: null };
    },
    
    /**
     * Save analysis for a specific date and period
     */
    saveAnalysis(dateStr, period, analysis) {
        const data = this.getAll();
        if (!data.days[dateStr]) {
            data.days[dateStr] = { morning: null, afternoon: null, combined: null };
        }
        data.days[dateStr][period] = analysis;
        
        // If both morning and afternoon exist, calculate combined
        if (data.days[dateStr].morning && data.days[dateStr].afternoon) {
            data.days[dateStr].combined = this.combineAnalyses(
                data.days[dateStr].morning,
                data.days[dateStr].afternoon
            );
        }
        
        // Add to upload history
        data.uploadHistory.unshift({
            ...analysis,
            dateStr,
            period,
            uploadedAt: new Date().toISOString()
        });
        
        // Keep only last 100 entries
        if (data.uploadHistory.length > 100) {
            data.uploadHistory = data.uploadHistory.slice(0, 100);
        }
        
        this.saveAll(data);
        return data.days[dateStr];
    },
    
    /**
     * Combine morning and afternoon analyses
     */
    combineAnalyses(morning, afternoon) {
        const totalRecords = morning.recordCount + afternoon.recordCount;
        const totalAlarms = morning.statusCounts.alarm + afternoon.statusCounts.alarm;
        const totalWarnings = morning.statusCounts.warning + afternoon.statusCounts.warning;
        const totalNormal = morning.statusCounts.normal + afternoon.statusCounts.normal;
        const totalErrors = morning.statusCounts.error + afternoon.statusCounts.error;
        const totalStatuses = totalAlarms + totalWarnings + totalNormal + totalErrors;
        
        const alarmRate = (totalAlarms / totalStatuses) * 100;
        const warningRate = (totalWarnings / totalStatuses) * 100;
        
        let prediction, severity;
        if (alarmRate > 15 || warningRate > 25) {
            prediction = 'FAULT';
            severity = 'critical';
        } else if (alarmRate > 5 || warningRate > 10) {
            prediction = 'WARNING';
            severity = 'moderate';
        } else {
            prediction = 'NORMAL';
            severity = 'none';
        }
        
        const confidence = Math.min(98, 85 + (100 - alarmRate - warningRate) / 10);
        const rul = Math.max(24, Math.floor(1000 - (alarmRate * 30) - (warningRate * 10)));
        
        return {
            prediction,
            confidence: confidence.toFixed(1),
            rul,
            severity,
            recordCount: totalRecords,
            alarmRate: alarmRate.toFixed(2),
            warningRate: warningRate.toFixed(2),
            statusCounts: {
                alarm: totalAlarms,
                warning: totalWarnings,
                normal: totalNormal,
                error: totalErrors
            },
            timeRange: {
                start: morning.timeRange.start,
                end: afternoon.timeRange.end
            },
            issues: [...(morning.issues || []), ...(afternoon.issues || [])]
        };
    },
    
    /**
     * Get upload history
     */
    getUploadHistory() {
        return this.getAll().uploadHistory || [];
    },
    
    /**
     * Get all dates that have data
     */
    getDatesWithData() {
        const data = this.getAll();
        return Object.keys(data.days).sort();
    }
};

// ============================================
// BACKEND API SERVICE (LOCAL DOCKER)
//
// This dashboard was originally written as a full frontend simulation.
// For Senior 2, we connect it to the real FastAPI backend running in Docker.
//
// IMPORTANT:
// - When running via docker compose, the API should be reachable at http://localhost:8000
// - If you change ports, update API_BASE_URL below.
// ============================================
const API_BASE_URL = (window.DANS_API_BASE_URL || 'http://localhost:8000') + '/v1';

const BackendAPI = {
    baseUrl: API_BASE_URL,

    // -----------------------------
    // Real backend calls
    // -----------------------------
    async uploadAndAnalyze(file) {
        const form = new FormData();
        form.append('file', file);

        const res = await fetch(`${this.baseUrl}/uploads?allow_overwrite=true`, {
            method: 'POST',
            body: form
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Upload failed (${res.status}): ${text || res.statusText}`);
        }

        return res.json();
    },

    async getDates() {
        const res = await fetch(`${this.baseUrl}/dates`);
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    },

    async getDay(dateStr) {
        const res = await fetch(`${this.baseUrl}/days/${encodeURIComponent(dateStr)}`);
        if (res.status === 404) return null;
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Failed to load day (${res.status}): ${text || res.statusText}`);
        }
        return res.json();
    },

    async getHistory(limit = 100) {
        const res = await fetch(`${this.baseUrl}/history?limit=${limit}`);
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    },

    // -----------------------------
    // Helpers / compatibility
    // -----------------------------

    /**
     * Detect file period (morning/afternoon) from filename
     * Pattern: ContMon_YYYY-MM-DD-a.log (morning) or ContMon_YYYY-MM-DD-b.log (afternoon)
     */
    detectFilePeriod(filename) {
        const match = filename.match(/(\d{4}-\d{2}-\d{2})-([ab])/i);
        if (match) {
            return {
                dateStr: match[1],
                period: match[2].toLowerCase() === 'a' ? 'morning' : 'afternoon',
                periodLabel: match[2].toLowerCase() === 'a' ? 'Morning (a)' : 'Afternoon (b)'
            };
        }

        // Try to extract just the date
        const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
            return {
                dateStr: dateMatch[1],
                period: 'unknown',
                periodLabel: 'Unknown Period'
            };
        }

        // Default to today
        const today = new Date().toISOString().split('T')[0];
        return {
            dateStr: today,
            period: 'unknown',
            periodLabel: 'Unknown Period'
        };
    },

    simulateDelay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },

    generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
};

// ============================================
// NORMALIZERS (backend -> frontend shape)
// ============================================
function normalizeAnalysis(a) {
    if (!a) return null;

    const feats = a.features || a.parsed_features || {};

    // Period/date: backend may provide, otherwise caller should inject from filename detection
    const period = a.period || a.periodName || a.period_name || 'unknown';
    const periodLabel =
        a.periodLabel ||
        a.period_label ||
        (period === 'morning' ? 'Morning (a)' : period === 'afternoon' ? 'Afternoon (b)' : 'Unknown Period');

    // Record count: backend day endpoints use recordCount; upload endpoint provides features.lines
    let recordCount =
        a.record_count ??
        a.recordCount ??
        a.recordsAnalyzed ??
        feats.lines ??
        feats.line_count ??
        0;

    // Status counts: upload endpoint provides alarm_hits/warning_hits in features
    const alarm =
        a.alarm_count ??
        a.statusCounts?.alarm ??
        a.status_counts?.alarm ??
        feats.alarm_hits ??
        feats.alarms ??
        0;

    const warning =
        a.warning_count ??
        a.statusCounts?.warning ??
        a.status_counts?.warning ??
        feats.warning_hits ??
        feats.warnings ??
        0;

    const error =
        a.error_count ??
        a.statusCounts?.error ??
        a.status_counts?.error ??
        feats.error_hits ??
        0;

    // If recordCount is missing but we have counts, infer something sensible
    if ((!recordCount || recordCount === 0) && (alarm || warning || error)) {
        recordCount = alarm + warning + error;
    }

    const normal =
        a.normal_count ??
        a.statusCounts?.normal ??
        a.status_counts?.normal ??
        Math.max(0, recordCount - alarm - warning - error);

    const statusCounts = { alarm, warning, normal, error };

    // Confidence: convert 0..1 -> 0..100, always return as string with 1 decimal
    let confRaw = a.confidence ?? a.ml?.confidence ?? 0;
    let confNum = typeof confRaw === 'string' ? parseFloat(confRaw) : Number(confRaw);
    if (Number.isNaN(confNum)) confNum = 0;
    if (confNum <= 1) confNum *= 100;

    // RUL: hours
    const rulVal = a.rul_hours ?? a.rul ?? a.ml?.rul_hours ?? a.ml?.estimatedRUL ?? 0;

    // Rates: compute if not present
    const alarmRateRaw =
        a.alarm_rate ?? a.metrics?.alarmRate ?? feats.alarm_rate ?? a.alarmRate ?? null;
    const warningRateRaw =
        a.warning_rate ?? a.metrics?.warningRate ?? feats.warning_rate ?? a.warningRate ?? null;

    const alarmRate =
        alarmRateRaw != null
            ? alarmRateRaw
            : recordCount
                ? ((alarm / recordCount) * 100).toFixed(2)
                : '0.00';

    const warningRate =
        warningRateRaw != null
            ? warningRateRaw
            : recordCount
                ? ((warning / recordCount) * 100).toFixed(2)
                : '0.00';

    return {
        id: a.id ?? a.upload_id ?? a.uploadId,
        timestamp: a.uploaded_at ?? a.ingest_timestamp ?? a.timestamp ?? new Date().toISOString(),
        uploadedAt: a.uploaded_at ?? a.ingest_timestamp ?? a.uploadedAt ?? new Date().toISOString(),
        filename: a.filename,
        dateStr: a.date_str ?? a.dateStr,
        period,
        periodLabel,
        recordCount,
        prediction: a.prediction ?? a.ml?.prediction ?? 'NORMAL',
        confidence: confNum.toFixed(1),
        rul: typeof rulVal === 'number' ? Math.round(rulVal) : Math.round(parseFloat(rulVal) || 0),
        severity: a.severity ?? a.ml?.severity ?? 'none',
        alarmRate,
        warningRate,
        metrics: a.metrics ?? a.ml?.metrics,
        issues: a.issues ?? a.ml?.issues ?? [],
        statusCounts,
        timeRange: a.timeRange ?? a.time_range ?? { start: 'N/A', end: 'N/A' }
    };
}

function normalizeDayData(day) {
    if (!day) return { morning: null, afternoon: null, combined: null };
    return {
        morning: normalizeAnalysis(day.morning),
        afternoon: normalizeAnalysis(day.afternoon),
        combined: normalizeAnalysis(day.combined)
    };
}

// ============================================
// DOM ELEMENTS
// ============================================
const loginScreen = document.getElementById('loginScreen');
const dashboardScreen = document.getElementById('dashboardScreen');
const loginForm = document.getElementById('loginForm');
const logoutBtn = document.getElementById('logoutBtn');
const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page');
const pageTitle = document.getElementById('pageTitle');

// Upload elements
const uploadDropzone = document.getElementById('uploadDropzone');
const fileInput = document.getElementById('fileInput');
const filesListPreview = document.getElementById('filesListPreview');
const filesList = document.getElementById('filesList');
const filesSummary = document.getElementById('filesSummary');
const clearAllFilesBtn = document.getElementById('clearAllFilesBtn');
const analyzeBtn = document.getElementById('analyzeBtn');
const processingSection = document.getElementById('processingSection');
const resultsSection = document.getElementById('resultsSection');

// Date navigation elements
const prevDateBtn = document.getElementById('prevDateBtn');
const nextDateBtn = document.getElementById('nextDateBtn');
const currentDateDisplay = document.getElementById('currentDateDisplay');
const datePickerInput = document.getElementById('datePickerInput');
const dateDisplayContainer = document.getElementById('dateDisplayContainer');

// Chart instances
let rulChart = null;
let faultChart = null;
let faultHistoryChart = null;

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', function() {
    initializeEventListeners();
    initializeCharts();
    initializeDateNavigation();
    loadPersistedData().catch(err => {
        console.error('Failed to load persisted data:', err);
    });
});

function initializeEventListeners() {
    // Login
    loginForm.addEventListener('submit', handleLogin);
    logoutBtn.addEventListener('click', handleLogout);
    
    // Navigation - re-query to ensure fresh NodeList
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const page = item.dataset.page;
            if (page) {
                navigateToPage(page);
            }
        });
    });
    
    // File upload
    uploadDropzone.addEventListener('click', () => fileInput.click());
    uploadDropzone.addEventListener('dragover', handleDragOver);
    uploadDropzone.addEventListener('dragleave', handleDragLeave);
    uploadDropzone.addEventListener('drop', handleDrop);
    fileInput.addEventListener('change', handleFileSelect);
    clearAllFilesBtn.addEventListener('click', clearAllFiles);
    analyzeBtn.addEventListener('click', startAnalysis);
    
    // Date navigation
    prevDateBtn.addEventListener('click', () => navigateDate(-1));
    nextDateBtn.addEventListener('click', () => navigateDate(1));
    dateDisplayContainer.addEventListener('click', () => datePickerInput.click());
    datePickerInput.addEventListener('change', handleDatePickerChange);
}

function initializeDateNavigation() {
    const today = new Date();
    AppState.selectedDate = today;
    datePickerInput.max = today.toISOString().split('T')[0];
    updateDateDisplay();
}

async function loadPersistedData() {
    // Prefer backend persistence; fall back to localStorage simulation if API is unavailable
    let dates = [];
    try {
        dates = await BackendAPI.getDates();
        AppState.availableDates = dates;
    } catch (e) {
        console.warn('API dates unavailable, falling back to local storage', e);
        dates = DataStore.getDatesWithData();
        AppState.availableDates = dates;
    }

    if (dates.length > 0) {
        AppState.minHistoryDate = new Date(dates[0] + 'T12:00:00');
    }

    // Load data for current date
    await loadDateData(AppState.selectedDate);
    await updateUploadHistory();
    await updateFaultInsights();
}

// ============================================
// DATE NAVIGATION
// ============================================
function formatDateDisplay(date) {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    const dateStr = date.toISOString().split('T')[0];
    const todayStr = today.toISOString().split('T')[0];
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    
    if (dateStr === todayStr) {
        return 'Today - ' + date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    } else if (dateStr === yesterdayStr) {
        return 'Yesterday - ' + date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }
    return date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function updateDateDisplay() {
    currentDateDisplay.textContent = formatDateDisplay(AppState.selectedDate);
    datePickerInput.value = AppState.selectedDate.toISOString().split('T')[0];
    
    // Update navigation buttons
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const selectedStr = AppState.selectedDate.toISOString().split('T')[0];
    
    nextDateBtn.disabled = selectedStr >= todayStr;
    
    // Check if there's older data
    const dates = (AppState.availableDates && AppState.availableDates.length > 0) ? AppState.availableDates : DataStore.getDatesWithData();
    if (dates.length > 0) {
        const oldestDate = dates[0];
        prevDateBtn.disabled = selectedStr <= oldestDate;
    }
}

function navigateDate(direction) {
    const newDate = new Date(AppState.selectedDate);
    newDate.setDate(newDate.getDate() + direction);
    
    const today = new Date();
    if (newDate > today) return;
    
    AppState.selectedDate = newDate;
    updateDateDisplay();
    loadDateData(newDate);
}

function handleDatePickerChange(e) {
    const selectedDate = new Date(e.target.value + 'T12:00:00');
    const today = new Date();
    
    if (selectedDate > today) {
        showToast('Cannot select future dates', 'error');
        return;
    }
    
    AppState.selectedDate = selectedDate;
    updateDateDisplay();
    loadDateData(selectedDate);
}

async function loadDateData(date) {
    const dateStr = date.toISOString().split('T')[0];

    let dayData;
    try {
        const backendDay = await BackendAPI.getDay(dateStr);
        if (backendDay) {
            dayData = normalizeDayData(backendDay);
        } else {
            dayData = { morning: null, afternoon: null, combined: null };
        }
    } catch (e) {
        console.warn('API day load failed, falling back to local storage', e);
        dayData = DataStore.getDateData(dateStr);
    }

    updateDayCoverageCard(dayData);
    updateDashboardForDate(dayData, dateStr);
}

function updateDayCoverageCard(dayData) {
    const coverageBadge = document.getElementById('coverageBadge');
    const morningSegment = document.getElementById('morningSegment');
    const afternoonSegment = document.getElementById('afternoonSegment');
    const morningStatus = document.getElementById('morningStatus');
    const afternoonStatus = document.getElementById('afternoonStatus');
    
    // Reset classes
    morningSegment.classList.remove('uploaded', 'warning', 'fault');
    afternoonSegment.classList.remove('uploaded', 'warning', 'fault');
    
    if (dayData.morning) {
        morningSegment.classList.add('uploaded');
        morningStatus.textContent = `Uploaded - ${dayData.morning.prediction}`;
        if (dayData.morning.prediction === 'WARNING') morningSegment.classList.add('warning');
        if (dayData.morning.prediction === 'FAULT') morningSegment.classList.add('fault');
    } else {
        morningStatus.textContent = 'Not Uploaded';
    }
    
    if (dayData.afternoon) {
        afternoonSegment.classList.add('uploaded');
        afternoonStatus.textContent = `Uploaded - ${dayData.afternoon.prediction}`;
        if (dayData.afternoon.prediction === 'WARNING') afternoonSegment.classList.add('warning');
        if (dayData.afternoon.prediction === 'FAULT') afternoonSegment.classList.add('fault');
    } else {
        afternoonStatus.textContent = 'Not Uploaded';
    }
    
    // Update badge
    if (dayData.morning && dayData.afternoon) {
        coverageBadge.textContent = 'Full Day';
        coverageBadge.className = 'coverage-badge full';
    } else if (dayData.morning || dayData.afternoon) {
        coverageBadge.textContent = dayData.morning ? 'Morning Only' : 'Afternoon Only';
        coverageBadge.className = 'coverage-badge partial';
    } else {
        coverageBadge.textContent = 'No Data';
        coverageBadge.className = 'coverage-badge empty';
    }
}

function updateDashboardForDate(dayData, dateStr) {
    // Determine which data to show (combined if available, otherwise most recent)
    let displayData = null;
    let coverage = 'none';
    
    if (dayData.combined) {
        displayData = dayData.combined;
        coverage = 'full';
    } else if (dayData.morning) {
        displayData = dayData.morning;
        coverage = 'morning';
    } else if (dayData.afternoon) {
        displayData = dayData.afternoon;
        coverage = 'afternoon';
    }
    
    if (displayData) {
        // Update system state
        const prediction = displayData.prediction;
        if (prediction === 'FAULT') {
            updateSystemState('fault');
        } else if (prediction === 'WARNING') {
            updateSystemState('warning');
        } else {
            updateSystemState('ok');
        }
        
        // Update status cards
        updateDashboardCards(displayData);
        
        // Update charts
        updateChartsWithData(displayData);
        
        // Update alerts table
        updateAlertsTable(displayData);
    } else {
        // No data for this date
        updateSystemState('idle');
        resetDashboardCards();
    }
}

// ============================================
// AUTHENTICATION
// ============================================
function handleLogin(e) {
    e.preventDefault();
    AppState.isLoggedIn = true;
    loginScreen.style.display = 'none';
    dashboardScreen.style.display = 'flex';
    showToast('Welcome to DANS ILS Monitor', 'success');
    loadDateData(AppState.selectedDate);
}

function handleLogout() {
    AppState.isLoggedIn = false;
    dashboardScreen.style.display = 'none';
    loginScreen.style.display = 'flex';
    showToast('Logged out successfully', 'info');
}

// ============================================
// NAVIGATION
// ============================================
function navigateToPage(pageName) {
    // Explicit mapping from nav data-page to HTML element IDs
    const pageIdMap = {
        'dashboard': 'dashboardPage',
        'data-upload': 'dataUploadPage',
        'fault-insights': 'faultInsightsPage',
        'user-management': 'userManagementPage'
    };
    
    const targetPageId = pageIdMap[pageName];
    
    // Update nav items
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === pageName);
    });
    
    // Update pages - hide all, show target
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });
    
    const targetPage = document.getElementById(targetPageId);
    if (targetPage) {
        targetPage.classList.add('active');
    }
    
    const titles = {
        'dashboard': 'Dashboard Overview',
        'data-upload': 'Data Upload & Analysis',
        'fault-insights': 'Fault Insights',
        'user-management': 'User Management'
    };
    
    pageTitle.textContent = titles[pageName] || 'Dashboard';
    AppState.currentPage = pageName;
    
    if (pageName === 'fault-insights') {
        updateFaultInsights();
    }
}

// ============================================
// FILE UPLOAD - MULTI-FILE SUPPORT
// ============================================
function handleDragOver(e) {
    e.preventDefault();
    uploadDropzone.classList.add('dragover');
}

function handleDragLeave(e) {
    e.preventDefault();
    uploadDropzone.classList.remove('dragover');
}

function handleDrop(e) {
    e.preventDefault();
    uploadDropzone.classList.remove('dragover');
    
    const files = Array.from(e.dataTransfer.files);
    addFiles(files);
}

function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    addFiles(files);
}

function addFiles(newFiles) {
    // Filter valid files
    const validFiles = newFiles.filter(file => {
        const ext = file.name.split('.').pop().toLowerCase();
        return ['log', 'txt', 'csv'].includes(ext);
    });
    
    if (validFiles.length === 0) {
        showToast('No valid files selected. Use .log, .txt, or .csv files.', 'error');
        return;
    }
    
    // Add to current files (avoid duplicates)
    validFiles.forEach(file => {
        const exists = AppState.currentFiles.some(f => f.name === file.name && f.size === file.size);
        if (!exists) {
            // Detect period from filename
            const fileInfo = BackendAPI.detectFilePeriod(file.name);
            file.fileInfo = fileInfo;
            AppState.currentFiles.push(file);
        }
    });
    
    updateFilesListUI();
    analyzeBtn.disabled = AppState.currentFiles.length === 0;
    showToast(`${validFiles.length} file(s) added`, 'success');
}

function updateFilesListUI() {
    if (AppState.currentFiles.length === 0) {
        filesListPreview.style.display = 'none';
        return;
    }
    
    filesListPreview.style.display = 'block';
    
    // Build files list HTML
    filesList.innerHTML = AppState.currentFiles.map((file, index) => `
        <div class="file-item">
            <div class="file-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" stroke="#004E89" stroke-width="2"/>
                    <path d="M14 2V8H20" stroke="#004E89" stroke-width="2"/>
                </svg>
            </div>
            <div class="file-details">
                <span class="file-name">${file.name}</span>
                <span class="file-meta">
                    ${formatFileSize(file.size)} • 
                    <span class="period-badge ${file.fileInfo.period}">${file.fileInfo.periodLabel}</span> • 
                    ${file.fileInfo.dateStr}
                </span>
            </div>
            <button class="btn-remove-file" onclick="removeFile(${index})">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
            </button>
        </div>
    `).join('');
    
    // Update summary
    const dates = [...new Set(AppState.currentFiles.map(f => f.fileInfo.dateStr))];
    const periods = [...new Set(AppState.currentFiles.map(f => f.fileInfo.period))];
    
    let coverageText = '';
    if (periods.includes('morning') && periods.includes('afternoon')) {
        coverageText = '<span class="coverage-full">Full day coverage detected</span>';
    } else if (periods.includes('morning')) {
        coverageText = '<span class="coverage-partial">Morning (a) only</span>';
    } else if (periods.includes('afternoon')) {
        coverageText = '<span class="coverage-partial">Afternoon (b) only</span>';
    } else {
        coverageText = '<span class="coverage-unknown">Period unknown</span>';
    }
    
    filesSummary.innerHTML = `
        <div class="summary-row">
            <span>${AppState.currentFiles.length} file(s) selected</span>
            <span>Date(s): ${dates.join(', ')}</span>
            ${coverageText}
        </div>
    `;
}

function removeFile(index) {
    AppState.currentFiles.splice(index, 1);
    updateFilesListUI();
    analyzeBtn.disabled = AppState.currentFiles.length === 0;
}

function clearAllFiles() {
    AppState.currentFiles = [];
    updateFilesListUI();
    analyzeBtn.disabled = true;
    fileInput.value = '';
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function resetUpload() {
    clearAllFiles();
    processingSection.style.display = 'none';
    resultsSection.style.display = 'none';
    document.querySelector('.upload-card').style.display = 'block';
}

// ============================================
// ANALYSIS WORKFLOW
// ============================================
async function startAnalysis() {
    if (AppState.currentFiles.length === 0) return;

    document.querySelector('.upload-card').style.display = 'none';
    processingSection.style.display = 'block';
    resultsSection.style.display = 'none';

    updateSystemState('processing');

    const allResults = [];

    try {
        for (let i = 0; i < AppState.currentFiles.length; i++) {
            const file = AppState.currentFiles[i];
            const fileInfo = file.fileInfo;

            // Step 1: Upload (backend also parses + infers + stores)
            updateProcessingStep(1, `Uploading ${file.name}...`);

            const uploadResponse = await BackendAPI.uploadAndAnalyze(file);

            // Step 2-5: UI progress steps (backend already did the work)
            updateProcessingStep(2, `Parsing ${file.name}...`);
            await BackendAPI.simulateDelay(250);
            updateProcessingStep(3, `Running inference on ${file.name}...`);
            await BackendAPI.simulateDelay(250);
            updateProcessingStep(4, 'Finalizing predictions...');
            await BackendAPI.simulateDelay(250);
            updateProcessingStep(5, 'Storing results...');
            await BackendAPI.simulateDelay(200);

            // Convert backend response to the frontend analysis shape
            const analysis = normalizeAnalysis({
                upload_id: uploadResponse.upload_id,
                filename: uploadResponse.filename,
                date_str: uploadResponse.date_str,
                period: uploadResponse.period,
                ingest_timestamp: uploadResponse.ingest_timestamp,
                record_count: uploadResponse.record_count,
                status_counts: uploadResponse.status_counts,
                features: uploadResponse.features,
                ml: uploadResponse.ml
            });

            // Ensure label from filename detection if backend period is unknown
            analysis.periodLabel = fileInfo?.periodLabel || analysis.periodLabel;

            // Ensure period/date from filename detection (upload endpoint does not return these)
            analysis.period = fileInfo?.period || analysis.period;
            analysis.dateStr = fileInfo?.dateStr || analysis.dateStr;
            analysis.periodLabel = fileInfo?.periodLabel || analysis.periodLabel;


            allResults.push(analysis);
        }

        // Display combined results
        displayResults(allResults);

    } catch (error) {
        console.error('Analysis error:', error);
        showToast('Analysis failed: ' + error.message, 'error');
        resetUpload();
    }
}

function readFileContent(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (e) => reject(new Error('Failed to read file'));
        reader.readAsText(file);
    });
}

function updateProcessingStep(stepNum, status) {
    document.getElementById('processingStatus').textContent = status;
    
    for (let i = 1; i <= 5; i++) {
        const step = document.getElementById(`step${i}`);
        step.classList.remove('active', 'complete');
        if (i < stepNum) step.classList.add('complete');
        if (i === stepNum) step.classList.add('active');
    }
}

function displayResults(results) {
    processingSection.style.display = 'none';
    resultsSection.style.display = 'block';
    
    // Aggregate results
    let totalRecords = 0;
    let totalAlarms = 0;
    let totalWarnings = 0;
    let worstPrediction = 'NORMAL';
    let allIssues = [];
    let timeStart = null;
    let timeEnd = null;
    let avgConfidence = 0;
    let avgRul = 0;
    
    const periods = new Set();
    const dates = new Set();
    
    results.forEach(r => {
        totalRecords += r.recordCount;
        totalAlarms += r.statusCounts.alarm;
        totalWarnings += r.statusCounts.warning;
        allIssues = [...allIssues, ...r.issues];
        avgConfidence += parseFloat(r.confidence);
        avgRul += r.rul;
        
        if (!timeStart || r.timeRange.start < timeStart) timeStart = r.timeRange.start;
        if (!timeEnd || r.timeRange.end > timeEnd) timeEnd = r.timeRange.end;
        
        if (r.prediction === 'FAULT') worstPrediction = 'FAULT';
        else if (r.prediction === 'WARNING' && worstPrediction !== 'FAULT') worstPrediction = 'WARNING';
        
        periods.add(r.period);
        dates.add(r.dateStr);
    });
    
    avgConfidence = (avgConfidence / results.length).toFixed(1);
    avgRul = Math.round(avgRul / results.length);
    
    // Update UI
    const predictionBadge = document.getElementById('predictionBadge');
    const predictionStatus = document.getElementById('predictionStatus');
    
    predictionBadge.className = 'prediction-badge ' + worstPrediction.toLowerCase();
    predictionStatus.textContent = worstPrediction === 'NORMAL' ? 'Normal Operation' : worstPrediction;
    
    document.getElementById('predictionConfidence').textContent = avgConfidence + '%';
    document.getElementById('recordsAnalyzed').textContent = totalRecords.toLocaleString();
    document.getElementById('timeRange').textContent = `${timeStart} - ${timeEnd}`;
    document.getElementById('estimatedRul').textContent = avgRul + ' hours';
    
    // Day coverage
    let coverageText = '';
    if (periods.has('morning') && periods.has('afternoon')) {
        coverageText = 'Full Day (a + b)';
    } else if (periods.has('morning')) {
        coverageText = 'Partial (a only)';
    } else if (periods.has('afternoon')) {
        coverageText = 'Partial (b only)';
    } else {
        coverageText = 'Unknown';
    }
    document.getElementById('dayCoverageResult').textContent = coverageText;
    
    // Summary
    document.getElementById('totalAlarms').textContent = totalAlarms.toLocaleString();
    document.getElementById('totalWarnings').textContent = totalWarnings.toLocaleString();
    document.getElementById('alarmRate').textContent = ((totalAlarms / (totalAlarms + totalWarnings + 1)) * 100).toFixed(1) + '%';
    document.getElementById('dataQuality').textContent = totalRecords > 10000 ? 'Good' : 'Limited';
    
    // Issues
    displayIssues(allIssues);
    
    // Update system state
    if (worstPrediction === 'FAULT') updateSystemState('fault');
    else if (worstPrediction === 'WARNING') updateSystemState('warning');
    else updateSystemState('ok');
    
    // Reload current date data
    loadDateData(AppState.selectedDate);
    updateUploadHistory();
    updateFaultInsights();
    
    showToast('Analysis complete!', 'success');
}

function displayIssues(issues) {
    const issuesList = document.getElementById('issuesList');
    
    if (issues.length === 0) {
        issuesList.innerHTML = '<p class="no-issues">No significant issues detected</p>';
        return;
    }
    
    issuesList.innerHTML = issues.map(issue => `
        <div class="issue-card ${issue.severity}">
            <div class="issue-header">
                <span class="issue-type">${issue.type.replace(/_/g, ' ').toUpperCase()}</span>
                <span class="issue-severity ${issue.severity}">${issue.severity}</span>
            </div>
            <p class="issue-description">${issue.description}</p>
            <p class="issue-recommendation"><strong>Recommendation:</strong> ${issue.recommendation}</p>
        </div>
    `).join('');
}

// ============================================
// SYSTEM STATE MANAGEMENT
// ============================================
function updateSystemState(state) {
    AppState.systemState = state;
    
    const stateConfigs = {
        idle: {
            class: 'idle',
            text: 'Awaiting Data Upload',
            sidebarText: 'Idle - No Data',
            bannerTitle: 'System Idle - No Data Loaded',
            bannerMessage: 'Upload a Glide Path (GP) datalog file to begin analysis.',
            statusValue: 'Idle',
            statusDesc: 'Awaiting data upload'
        },
        processing: {
            class: 'processing',
            text: 'Processing Data...',
            sidebarText: 'Processing...',
            bannerTitle: 'Processing Data',
            bannerMessage: 'Analysis in progress. Please wait...',
            statusValue: 'Processing',
            statusDesc: 'Analyzing uploaded data'
        },
        ok: {
            class: 'ok',
            text: 'System Operating Normally',
            sidebarText: 'Normal Operation',
            bannerTitle: 'System Operating Normally',
            bannerMessage: 'All parameters within acceptable limits. No issues detected.',
            statusValue: 'Normal',
            statusDesc: 'All systems operational'
        },
        warning: {
            class: 'warning',
            text: 'Warning - Attention Required',
            sidebarText: 'Warning Detected',
            bannerTitle: 'Warning - Attention Required',
            bannerMessage: 'Some parameters showing abnormal readings. Review recommended.',
            statusValue: 'Warning',
            statusDesc: 'Anomalies detected'
        },
        fault: {
            class: 'fault',
            text: 'Fault Detected',
            sidebarText: 'Fault Detected',
            bannerTitle: 'Fault Detected - Action Required',
            bannerMessage: 'Critical issues detected. Immediate inspection recommended.',
            statusValue: 'Fault',
            statusDesc: 'Critical issues detected'
        }
    };
    
    const config = stateConfigs[state];
    
    // Update status indicator
    const statusDot = document.querySelector('.status-dot');
    statusDot.className = 'status-dot ' + config.class;
    document.getElementById('systemStatusText').textContent = config.text;
    
    // Update sidebar
    const sidebarState = document.getElementById('sidebarSystemState');
    sidebarState.querySelector('.state-icon').className = 'state-icon ' + config.class;
    document.getElementById('sidebarStateValue').textContent = config.sidebarText;
    
    // Update banner
    const banner = document.getElementById('systemBanner');
    banner.className = 'system-banner ' + config.class;
    document.getElementById('bannerTitle').textContent = config.bannerTitle;
    document.getElementById('bannerMessage').textContent = config.bannerMessage;
    
    // Update status card
    document.getElementById('systemStatusValue').textContent = config.statusValue;
    document.getElementById('systemStatusDesc').textContent = config.statusDesc;
    document.getElementById('statusCard').className = 'status-card ' + config.class;
}

function updateDashboardCards(data) {
    // Anomaly rate
    document.getElementById('anomalyRate').textContent = data.alarmRate || data.metrics?.alarmRate || '0.00';
    document.getElementById('anomalyDesc').textContent = 'Based on current analysis';
    
    // RUL
    document.getElementById('rulValue').textContent = data.rul || data.estimatedRUL || '--';
    document.getElementById('rulDesc').textContent = 'Estimated remaining useful life';
    
    // Last analysis
    document.getElementById('lastAnalysisValue').textContent = 'Today';
    document.getElementById('lastAnalysisDesc').textContent = 'Latest analysis complete';
    
    // Hide chart overlays
    document.getElementById('rulChartOverlay').style.display = 'none';
    document.getElementById('faultChartOverlay').style.display = 'none';
}

function resetDashboardCards() {
    document.getElementById('anomalyRate').textContent = '0.00';
    document.getElementById('anomalyDesc').textContent = 'No data to analyze';
    document.getElementById('rulValue').textContent = '--';
    document.getElementById('rulDesc').textContent = 'Requires data for prediction';
    document.getElementById('lastAnalysisValue').textContent = 'Never';
    document.getElementById('lastAnalysisDesc').textContent = 'No analysis performed';
    
    document.getElementById('rulChartOverlay').style.display = 'flex';
    document.getElementById('faultChartOverlay').style.display = 'flex';
}

// ============================================
// CHARTS
// ============================================
function initializeCharts() {
    // RUL Chart
    const rulCtx = document.getElementById('rulChart').getContext('2d');
    rulChart = new Chart(rulCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'RUL (hours)',
                data: [],
                borderColor: '#004E89',
                backgroundColor: 'rgba(0, 78, 137, 0.1)',
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    min: 0,
                    max: 1200,
                    ticks: { stepSize: 200 }
                },
                x: {
                    display: true
                }
            }
        }
    });
    
    // Fault Distribution Chart
    const faultCtx = document.getElementById('faultChart').getContext('2d');
    faultChart = new Chart(faultCtx, {
        type: 'doughnut',
        data: {
            labels: ['Normal', 'Warning', 'Fault'],
            datasets: [{
                data: [0, 0, 0],
                backgroundColor: ['#22C55E', '#FACC15', '#DC2626']
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { boxWidth: 12, padding: 8 }
                }
            },
            cutout: '60%'
        }
    });
    
    // Fault History Chart
    const historyCtx = document.getElementById('faultHistoryChart').getContext('2d');
    faultHistoryChart = new Chart(historyCtx, {
        type: 'bar',
        data: {
            labels: [],
            datasets: [
                { label: 'Faults', data: [], backgroundColor: '#DC2626' },
                { label: 'Warnings', data: [], backgroundColor: '#FACC15' },
                { label: 'Normal', data: [], backgroundColor: '#22C55E' }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { boxWidth: 12, padding: 8 }
                }
            },
            scales: {
                y: { min: 0, max: 5, stacked: true },
                x: { stacked: true }
            }
        }
    });
}

function updateChartsWithData(data) {
    // Generate some historical data for demo
    const history = (AppState.history && AppState.history.length > 0 ? AppState.history : DataStore.getUploadHistory()).slice(0, 30);
    
    if (history.length > 0) {
        // RUL Chart
        const rulLabels = history.map((h, i) => `Day ${history.length - i}`).reverse();
        const rulData = history.map(h => h.rul).reverse();
        
        rulChart.data.labels = rulLabels;
        rulChart.data.datasets[0].data = rulData;
        rulChart.update();
        
        // Fault Distribution
        let faultCount = 0, warningCount = 0, normalCount = 0;
        history.forEach(h => {
            if (h.prediction === 'FAULT') faultCount++;
            else if (h.prediction === 'WARNING') warningCount++;
            else normalCount++;
        });
        
        faultChart.data.datasets[0].data = [normalCount, warningCount, faultCount];
        faultChart.update();
    }
}

// ============================================
// ALERTS TABLE
// ============================================
function updateAlertsTable(data) {
    const tbody = document.getElementById('alertsTableBody');
    const issues = data.issues || [];
    
    if (issues.length === 0) {
        tbody.innerHTML = `
            <tr class="no-data-row">
                <td colspan="5">
                    <div class="empty-state">
                        <p>No alerts to display for this date.</p>
                    </div>
                </td>
            </tr>
        `;
        return;
    }
    
    tbody.innerHTML = issues.map(issue => `
        <tr>
            <td>${new Date().toLocaleString()}</td>
            <td>Glide Path</td>
            <td>${issue.type.replace(/_/g, ' ')}</td>
            <td>${data.confidence}%</td>
            <td><span class="badge badge-${issue.severity === 'high' ? 'danger' : issue.severity === 'medium' ? 'warning' : 'info'}">${issue.severity}</span></td>
        </tr>
    `).join('');
}

// ============================================
// UPLOAD HISTORY
// ============================================
async function updateUploadHistory() {
    let history = [];
    try {
        const backendHistory = await BackendAPI.getHistory(100);
        history = backendHistory.map(normalizeAnalysis);
        AppState.history = history;
    } catch (e) {
        console.warn('API history unavailable, using local storage', e);
        history = DataStore.getUploadHistory();
        AppState.history = history;
    }

    const historyList = document.getElementById('historyList');
    const historyCount = document.getElementById('historyCount');

    historyCount.textContent = `${history.length} files`;

    if (history.length === 0) {
        historyList.innerHTML = `
            <div class=\"empty-history\">
                <svg width=\"48\" height=\"48\" viewBox=\"0 0 24 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">
                    <circle cx=\"12\" cy=\"12\" r=\"10\" stroke=\"#717182\" stroke-width=\"2\"/>
                    <path d=\"M12 6v6l4 2\" stroke=\"#717182\" stroke-width=\"2\" stroke-linecap=\"round\"/>
                </svg>
                <p>No upload history yet</p>
            </div>
        `;
        return;
    }

    historyList.innerHTML = history.slice(0, 20).map(h => `
        <div class=\"history-item\">
            <div class=\"history-icon ${String(h.prediction || '').toLowerCase()}\"></div>
            <div class=\"history-details\">
                <span class=\"history-filename\">${h.filename || 'Unknown'}</span>
                <span class=\"history-meta\">${h.dateStr || ''} • ${h.periodLabel || 'Unknown'}</span>
            </div>
            <span class=\"history-badge ${String(h.prediction || '').toLowerCase()}\">${h.prediction === 'NORMAL' ? 'Normal' : (h.prediction || 'N/A')}</span>
        </div>
    `).join('');
}

// ============================================
// FAULT INSIGHTS
// ============================================
async function updateFaultInsights() {
    // Ensure history is loaded
    if (!AppState.history || AppState.history.length === 0) {
        await updateUploadHistory();
    }

    const history = AppState.history || [];

    let faults = 0, warnings = 0, normal = 0;
    history.forEach(h => {
        if (h.prediction === 'FAULT') faults++;
        else if (h.prediction === 'WARNING') warnings++;
        else normal++;
    });

    document.getElementById('criticalFaults').textContent = faults;
    document.getElementById('warningFaults').textContent = warnings;
    document.getElementById('totalAnalyses').textContent = history.length;
    document.getElementById('normalOps').textContent = normal;

    // Update fault log table
    updateFaultLogTable(history);

    // Update chart
    if (history.length > 0) {
        document.getElementById('faultHistoryOverlay').style.display = 'none';

        // Group by date
        const byDate = {};
        history.forEach(h => {
            if (!byDate[h.dateStr]) byDate[h.dateStr] = { faults: 0, warnings: 0, normal: 0 };
            if (h.prediction === 'FAULT') byDate[h.dateStr].faults++;
            else if (h.prediction === 'WARNING') byDate[h.dateStr].warnings++;
            else byDate[h.dateStr].normal++;
        });

        const dates = Object.keys(byDate).sort().slice(-7);
        faultHistoryChart.data.labels = dates;
        faultHistoryChart.data.datasets[0].data = dates.map(d => byDate[d].faults);
        faultHistoryChart.data.datasets[1].data = dates.map(d => byDate[d].warnings);
        faultHistoryChart.data.datasets[2].data = dates.map(d => byDate[d].normal);
        faultHistoryChart.update();
    }
}

function updateFaultLogTable(history) {
    const tbody = document.getElementById('faultLogBody');
    
    if (history.length === 0) {
        tbody.innerHTML = `
            <tr class="no-data-row">
                <td colspan="7">
                    <div class="empty-state">
                        <p>No fault data to display.</p>
                    </div>
                </td>
            </tr>
        `;
        return;
    }
    
    tbody.innerHTML = history.slice(0, 50).map(h => `
        <tr>
            <td>${h.dateStr}</td>
            <td>${h.filename}</td>
            <td>${h.periodLabel || 'Unknown'}</td>
            <td>${h.recordCount?.toLocaleString() || 'N/A'}</td>
            <td><span class="badge badge-${h.prediction === 'FAULT' ? 'danger' : h.prediction === 'WARNING' ? 'warning' : 'success'}">${h.prediction === 'NORMAL' ? 'Normal' : h.prediction}</span></td>
            <td>${h.confidence}%</td>
            <td>${h.rul} hrs</td>
        </tr>
    `).join('');
}

// ============================================
// TOAST NOTIFICATIONS
// ============================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span>${message}</span>
        <button onclick="this.parentElement.remove()">×</button>
    `;
    container.appendChild(toast);
    
    setTimeout(() => toast.remove(), 4000);
}

// Make functions globally accessible
window.navigateToPage = navigateToPage;
window.resetUpload = resetUpload;
window.removeFile = removeFile;