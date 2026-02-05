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
    calendarViewDate: new Date(), // For calendar navigation
    calendarOpen: false,
    
    // Equipment type (gp or llz)
    selectedEquipmentType: 'gp',
    
    // Current analysis data
    currentFiles: [], // Array of selected files
    currentData: null,
    predictions: null,
    
    // Storage keys
    STORAGE_KEY: 'dans_ils_data',
    
    // File System Access API state
    folderHandle: null,
    detectedFiles: [],
    autoScanEnabled: false,
    autoScanInterval: null,
    lastScanTime: null,
    isScanning: false
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
            const parsed = data ? JSON.parse(data) : { days: {}, uploadHistory: [] };
            // Migrate old data structure if needed
            if (parsed.days && Object.keys(parsed.days).length > 0) {
                const firstDay = parsed.days[Object.keys(parsed.days)[0]];
                if (firstDay && !firstDay.gp && !firstDay.llz) {
                    // Old structure, migrate it
                    const migrated = { days: {}, uploadHistory: parsed.uploadHistory || [] };
                    Object.keys(parsed.days).forEach(dateStr => {
                        migrated.days[dateStr] = {
                            gp: parsed.days[dateStr],
                            llz: { morning: null, afternoon: null, combined: null }
                        };
                    });
                    this.saveAll(migrated);
                    return migrated;
                }
            }
            return parsed;
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
        return data.days[dateStr] || { 
            gp: { morning: null, afternoon: null, combined: null },
            llz: { morning: null, afternoon: null, combined: null }
        };
    },
    
    /**
     * Save analysis for a specific date, period, and equipment type
     */
    saveAnalysis(dateStr, period, equipmentType, analysis) {
        const data = this.getAll();
        if (!data.days[dateStr]) {
            data.days[dateStr] = {
                gp: { morning: null, afternoon: null, combined: null },
                llz: { morning: null, afternoon: null, combined: null }
            };
        }
        
        if (!data.days[dateStr][equipmentType]) {
            data.days[dateStr][equipmentType] = { morning: null, afternoon: null, combined: null };
        }
        
        data.days[dateStr][equipmentType][period] = analysis;
        
        // If both morning and afternoon exist, calculate combined
        const eqData = data.days[dateStr][equipmentType];
        if (eqData.morning && eqData.afternoon) {
            eqData.combined = this.combineAnalyses(eqData.morning, eqData.afternoon);
        }
        
        // Add to upload history
        data.uploadHistory.unshift({
            ...analysis,
            dateStr,
            period,
            equipmentType,
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
    getUploadHistory(equipmentType = null) {
        const history = this.getAll().uploadHistory || [];
        if (equipmentType) {
            return history.filter(h => h.equipmentType === equipmentType);
        }
        return history;
    },
    
    /**
     * Get all dates that have data
     */
    getDatesWithData() {
        const data = this.getAll();
        return Object.keys(data.days).sort();
    },
    
    /**
     * Get dates with data by equipment type
     */
    getDatesWithDataByType() {
        const data = this.getAll();
        const result = {};
        
        Object.keys(data.days).forEach(dateStr => {
            const dayData = data.days[dateStr];
            result[dateStr] = {
                gp: !!(dayData.gp?.morning || dayData.gp?.afternoon),
                llz: !!(dayData.llz?.morning || dayData.llz?.afternoon)
            };
        });
        
        return result;
    }
};

// ============================================
// FAKE BACKEND API SERVICE
// ============================================
const BackendAPI = {
    baseUrl: 'https://api.dans-ils.ae/v1',
    
    async uploadFile(file) {
        console.log(`[API] Uploading file: ${file.name} to ${this.baseUrl}/upload`);
        await this.simulateDelay(800);
        
        return {
            success: true,
            uploadId: this.generateUUID(),
            filename: file.name,
            size: file.size,
            timestamp: new Date().toISOString(),
            s3Location: `s3://dans-ils-data/uploads/${file.name}`
        };
    },
    
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
    
    /**
     * Detect equipment type (GP or LLZ) from file content
     * LLZ files contain 'CL ID MOD (%)' in the header
     * GP files do not contain this column
     */
    detectEquipmentType(fileContent) {
        // Check if the file contains 'CL ID MOD (%)' which is unique to LLZ files
        if (fileContent.includes('CL ID MOD (%)')) {
            return {
                type: 'llz',
                label: 'Localizer (LLZ)',
                shortLabel: 'LLZ'
            };
        } else {
            return {
                type: 'gp',
                label: 'Glide Path (GP)',
                shortLabel: 'GP'
            };
        }
    },
    
    async parseLogFile(fileContent) {
        console.log('[API] Parsing log file content...');
        await this.simulateDelay(1200);
        
        // Detect equipment type first
        const equipmentType = this.detectEquipmentType(fileContent);
        console.log(`[API] Detected equipment type: ${equipmentType.label}`);
        
        const lines = fileContent.split('\n');
        const dataLines = lines.filter(line => line.match(/^\d{4}-\d{2}-\d{2}/));
        
        const headerLine = lines.find(line => line.startsWith('Timestamp'));
        const columns = headerLine ? headerLine.split('\t') : [];
        
        const records = [];
        const statusCounts = { normal: 0, warning: 0, alarm: 0, error: 0 };
        
        dataLines.forEach(line => {
            const values = line.split('\t');
            if (values.length > 1) {
                const record = {
                    timestamp: values[0],
                    measurements: [],
                    statuses: []
                };
                
                for (let i = 1; i < values.length; i += 2) {
                    const value = parseFloat(values[i]) || 0;
                    const status = values[i + 1] ? values[i + 1].trim() : '';
                    
                    record.measurements.push(value);
                    record.statuses.push(status);
                    
                    if (status === '' || status === ' ') statusCounts.normal++;
                    else if (status === 'w' || status === 'W') statusCounts.warning++;
                    else if (status === 'a' || status === 'A') statusCounts.alarm++;
                    else if (status === '*' || status === '?') statusCounts.error++;
                }
                
                records.push(record);
            }
        });
        
        return {
            success: true,
            recordCount: records.length,
            columns: columns,
            records: records,
            statusCounts: statusCounts,
            equipmentType: equipmentType,
            timeRange: {
                start: records[0]?.timestamp || 'N/A',
                end: records[records.length - 1]?.timestamp || 'N/A'
            }
        };
    },
    
    async runMLInference(parsedData) {
        console.log('[API] Running ML inference (simulated)...');
        await this.simulateDelay(1500);
        
        const { statusCounts, recordCount, records } = parsedData;
        const totalStatuses = Object.values(statusCounts).reduce((a, b) => a + b, 0);
        
        const alarmRate = (statusCounts.alarm / totalStatuses) * 100;
        const warningRate = (statusCounts.warning / totalStatuses) * 100;
        const errorRate = (statusCounts.error / totalStatuses) * 100;
        const normalRate = (statusCounts.normal / totalStatuses) * 100;
        
        let prediction, confidence, rul, severity;
        
        if (alarmRate > 15 || warningRate > 25 || errorRate > 5) {
            prediction = 'FAULT';
            confidence = Math.min(95, 70 + alarmRate + warningRate / 2);
            rul = Math.max(24, Math.floor(500 - (alarmRate * 20) - (warningRate * 5)));
            severity = 'critical';
        } else if (alarmRate > 5 || warningRate > 10) {
            prediction = 'WARNING';
            confidence = Math.min(92, 75 + alarmRate * 2);
            rul = Math.max(200, Math.floor(800 - (alarmRate * 30) - (warningRate * 10)));
            severity = 'moderate';
        } else {
            prediction = 'NORMAL';
            confidence = Math.min(98, 85 + normalRate / 10);
            rul = Math.max(500, Math.floor(1000 - (alarmRate * 50)));
            severity = 'none';
        }
        
        const issues = this.identifyIssues(parsedData);
        
        return {
            success: true,
            prediction: prediction,
            confidence: confidence.toFixed(1),
            estimatedRUL: rul,
            severity: severity,
            metrics: {
                alarmRate: alarmRate.toFixed(2),
                warningRate: warningRate.toFixed(2),
                errorRate: errorRate.toFixed(2),
                normalRate: normalRate.toFixed(2)
            },
            issues: issues,
            modelVersion: '1.0.0-simulation',
            inferenceTime: '1.2s'
        };
    },
    
    identifyIssues(parsedData) {
        const issues = [];
        const { statusCounts, records } = parsedData;
        
        let consecutiveAlarms = 0;
        let maxConsecutive = 0;
        
        records.forEach(record => {
            const hasAlarm = record.statuses.some(s => s === 'a' || s === 'A');
            if (hasAlarm) {
                consecutiveAlarms++;
                maxConsecutive = Math.max(maxConsecutive, consecutiveAlarms);
            } else {
                consecutiveAlarms = 0;
            }
        });
        
        if (maxConsecutive > 10) {
            issues.push({
                type: 'sustained_alarm',
                severity: 'high',
                description: `Sustained alarm condition detected (${maxConsecutive} consecutive records)`,
                recommendation: 'Immediate inspection of monitor system required'
            });
        }
        
        const rfIssues = records.filter(r => {
            const rfIndex = 2;
            return r.statuses[rfIndex] === 'A' || r.statuses[rfIndex] === 'a';
        }).length;
        
        if (rfIssues > records.length * 0.05) {
            issues.push({
                type: 'rf_level',
                severity: 'medium',
                description: 'RF level anomalies detected in monitoring data',
                recommendation: 'Check transmitter output and antenna connections'
            });
        }
        
        const ddmValues = records.map(r => r.measurements[0]).filter(v => !isNaN(v));
        const ddmMean = ddmValues.reduce((a, b) => a + b, 0) / ddmValues.length;
        const ddmStd = Math.sqrt(ddmValues.reduce((a, b) => a + Math.pow(b - ddmMean, 2), 0) / ddmValues.length);
        
        if (ddmStd > 5) {
            issues.push({
                type: 'ddm_drift',
                severity: 'medium',
                description: `High DDM variability detected (σ = ${ddmStd.toFixed(2)} µA)`,
                recommendation: 'Calibration check recommended'
            });
        }
        
        const sdmAlarms = records.filter(r => {
            const sdmIndex = 1;
            return r.statuses[sdmIndex] === 'A' || r.statuses[sdmIndex] === 'a';
        }).length;
        
        if (sdmAlarms > records.length * 0.1) {
            issues.push({
                type: 'sdm_alarm',
                severity: 'high',
                description: 'Modulation depth alarms detected',
                recommendation: 'Check modulator and signal processing chain'
            });
        }
        
        if (issues.length === 0 && statusCounts.alarm > 0) {
            issues.push({
                type: 'intermittent',
                severity: 'low',
                description: 'Intermittent alarm conditions observed',
                recommendation: 'Continue monitoring, schedule preventive maintenance'
            });
        }
        
        return issues;
    },
    
    async storeResults(uploadId, parsedData, predictions, fileInfo) {
        console.log('[API] Storing results to database...');
        await this.simulateDelay(600);
        
        // Get equipment type from parsed data
        const equipmentType = parsedData.equipmentType?.type || 'gp';
        
        const result = {
            id: uploadId,
            timestamp: new Date().toISOString(),
            filename: fileInfo.filename,
            dateStr: fileInfo.dateStr,
            period: fileInfo.period,
            periodLabel: fileInfo.periodLabel,
            equipmentType: equipmentType,
            equipmentLabel: parsedData.equipmentType?.label || 'Glide Path (GP)',
            recordCount: parsedData.recordCount,
            prediction: predictions.prediction,
            confidence: predictions.confidence,
            rul: predictions.estimatedRUL,
            alarmRate: predictions.metrics?.alarmRate || '0',
            metrics: predictions.metrics,
            issues: predictions.issues,
            statusCounts: parsedData.statusCounts,
            timeRange: parsedData.timeRange,
            stored: true
        };
        
        // Store in DataStore with equipment type
        DataStore.saveAnalysis(fileInfo.dateStr, fileInfo.period, equipmentType, result);
        
        return {
            success: true,
            resultId: uploadId,
            storedAt: result.timestamp,
            result: result
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
const dateDisplayContainer = document.getElementById('dateDisplayContainer');

// Chart instances
let rulChart = null;
let faultChart = null;
let faultHistoryChart = null;

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', function() {
    try {
        initializeEventListeners();
        initializeCharts();
        initializeDateNavigation();
        initializeFolderConnection();
        loadPersistedData();
    } catch (err) {
        console.error('Initialization error:', err);
    }
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
    // Calendar popup is initialized in initializeDateNavigation
}

function initializeDateNavigation() {
    const today = new Date();
    AppState.selectedDate = today;
    AppState.calendarViewDate = new Date(today);
    updateDateDisplay();
    initializeCalendar();
}

/**
 * Initialize calendar popup functionality
 */
function initializeCalendar() {
    const dateDisplayContainer = document.getElementById('dateDisplayContainer');
    const calendarPopup = document.getElementById('calendarPopup');
    const calendarPrevMonth = document.getElementById('calendarPrevMonth');
    const calendarNextMonth = document.getElementById('calendarNextMonth');
    
    if (!dateDisplayContainer || !calendarPopup) {
        console.warn('Calendar elements not found');
        return;
    }
    
    // Toggle calendar on date display click
    dateDisplayContainer.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCalendar();
    });
    
    // Month navigation
    if (calendarPrevMonth) {
        calendarPrevMonth.addEventListener('click', (e) => {
            e.stopPropagation();
            navigateCalendarMonth(-1);
        });
    }
    
    if (calendarNextMonth) {
        calendarNextMonth.addEventListener('click', (e) => {
            e.stopPropagation();
            navigateCalendarMonth(1);
        });
    }
    
    // Close calendar when clicking outside
    document.addEventListener('click', (e) => {
        const dateNav = document.querySelector('.date-navigation');
        if (dateNav && !dateNav.contains(e.target) && AppState.calendarOpen) {
            closeCalendar();
        }
    });
}

/**
 * Toggle calendar visibility
 */
function toggleCalendar() {
    AppState.calendarOpen = !AppState.calendarOpen;
    const dateNav = document.querySelector('.date-navigation');
    
    if (AppState.calendarOpen) {
        dateNav.classList.add('calendar-open');
        AppState.calendarViewDate = new Date(AppState.selectedDate);
        renderCalendar();
    } else {
        dateNav.classList.remove('calendar-open');
    }
}

/**
 * Close calendar
 */
function closeCalendar() {
    AppState.calendarOpen = false;
    const dateNav = document.querySelector('.date-navigation');
    if (dateNav) {
        dateNav.classList.remove('calendar-open');
    }
}

/**
 * Navigate calendar month
 */
function navigateCalendarMonth(direction) {
    AppState.calendarViewDate.setMonth(AppState.calendarViewDate.getMonth() + direction);
    renderCalendar();
}

/**
 * Render calendar with data indicators
 */
function renderCalendar() {
    const calendarDays = document.getElementById('calendarDays');
    const calendarMonthYear = document.getElementById('calendarMonthYear');
    
    if (!calendarDays || !calendarMonthYear) return;
    
    const viewDate = AppState.calendarViewDate;
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    
    // Update month/year display
    calendarMonthYear.textContent = viewDate.toLocaleDateString('en-US', { 
        month: 'long', 
        year: 'numeric' 
    });
    
    // Get dates with data
    const datesWithData = DataStore.getDatesWithDataByType();
    
    // Get first day of month and total days
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDayOfWeek = firstDay.getDay();
    const totalDays = lastDay.getDate();
    
    // Get today and selected date for comparison
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const selectedStr = AppState.selectedDate.toISOString().split('T')[0];
    
    // Build calendar HTML
    let html = '';
    
    // Add empty cells for days before first of month
    for (let i = 0; i < startDayOfWeek; i++) {
        html += '<button class="calendar-day other-month" disabled></button>';
    }
    
    // Add days of month
    for (let day = 1; day <= totalDays; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dateData = datesWithData[dateStr];
        const hasGP = dateData?.gp;
        const hasLLZ = dateData?.llz;
        const hasData = hasGP || hasLLZ;
        
        // Determine classes
        const classes = ['calendar-day'];
        if (dateStr === todayStr) classes.push('today');
        if (dateStr === selectedStr) classes.push('selected');
        if (hasData) classes.push('has-data');
        
        // Disable future dates
        const isDisabled = dateStr > todayStr;
        
        // Build data indicators
        let indicators = '';
        if (hasGP || hasLLZ) {
            indicators = '<div class="data-indicators">';
            if (hasGP) indicators += '<span class="data-dot gp"></span>';
            if (hasLLZ) indicators += '<span class="data-dot llz"></span>';
            indicators += '</div>';
        }
        
        html += `
            <button class="${classes.join(' ')}" 
                    onclick="selectCalendarDate('${dateStr}')" 
                    ${isDisabled ? 'disabled' : ''}>
                ${day}
                ${indicators}
            </button>
        `;
    }
    
    calendarDays.innerHTML = html;
}

/**
 * Select a date from calendar
 */
function selectCalendarDate(dateStr) {
    AppState.selectedDate = new Date(dateStr + 'T12:00:00');
    updateDateDisplay();
    loadDateData(AppState.selectedDate);
    closeCalendar();
}

// Make calendar functions globally accessible
window.selectCalendarDate = selectCalendarDate;

/**
 * Switch between GP and LLZ equipment tabs
 */
function switchEquipmentTab(type) {
    AppState.selectedEquipmentType = type;
    
    // Update tab buttons
    document.querySelectorAll('.equipment-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.type === type);
    });
    
    // Update coverage content
    document.getElementById('gpCoverage')?.classList.toggle('active', type === 'gp');
    document.getElementById('llzCoverage')?.classList.toggle('active', type === 'llz');
    
    // Refresh data display for selected equipment type
    loadDateData(AppState.selectedDate);
}

// Make function globally accessible
window.switchEquipmentTab = switchEquipmentTab;

function loadPersistedData() {
    const dates = DataStore.getDatesWithData();
    if (dates.length > 0) {
        AppState.minHistoryDate = new Date(dates[0]);
    }
    
    // Load data for current date
    loadDateData(AppState.selectedDate);
    updateUploadHistory();
    updateFaultInsights();
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
    
    // Update navigation buttons
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const selectedStr = AppState.selectedDate.toISOString().split('T')[0];
    
    nextDateBtn.disabled = selectedStr >= todayStr;
    
    // Check if there's older data
    const dates = DataStore.getDatesWithData();
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

function loadDateData(date) {
    const dateStr = date.toISOString().split('T')[0];
    const dayData = DataStore.getDateData(dateStr);
    
    updateDayCoverageCard(dayData);
    updateEquipmentStatusCards(dayData);
    updateDashboardForDate(dayData, dateStr);
}

function updateDayCoverageCard(dayData) {
    const coverageBadge = document.getElementById('coverageBadge');
    
    // Update GP coverage
    updateEquipmentCoverage('gp', dayData.gp);
    
    // Update LLZ coverage
    updateEquipmentCoverage('llz', dayData.llz);
    
    // Update overall badge
    const hasGPData = dayData.gp?.morning || dayData.gp?.afternoon;
    const hasLLZData = dayData.llz?.morning || dayData.llz?.afternoon;
    const gpFull = dayData.gp?.morning && dayData.gp?.afternoon;
    const llzFull = dayData.llz?.morning && dayData.llz?.afternoon;
    
    if (gpFull && llzFull) {
        coverageBadge.textContent = 'Full Coverage';
        coverageBadge.className = 'coverage-badge full';
    } else if (hasGPData || hasLLZData) {
        coverageBadge.textContent = 'Partial Coverage';
        coverageBadge.className = 'coverage-badge partial';
    } else {
        coverageBadge.textContent = 'No Data';
        coverageBadge.className = 'coverage-badge empty';
    }
}

function updateEquipmentCoverage(type, eqData) {
    const morningSegment = document.getElementById(`${type}MorningSegment`);
    const afternoonSegment = document.getElementById(`${type}AfternoonSegment`);
    const morningStatus = document.getElementById(`${type}MorningStatus`);
    const afternoonStatus = document.getElementById(`${type}AfternoonStatus`);
    
    if (!morningSegment || !afternoonSegment) return;
    
    // Reset classes
    morningSegment.classList.remove('uploaded', 'warning', 'fault');
    afternoonSegment.classList.remove('uploaded', 'warning', 'fault');
    
    if (eqData?.morning) {
        morningSegment.classList.add('uploaded');
        morningStatus.textContent = `Uploaded - ${eqData.morning.prediction}`;
        if (eqData.morning.prediction === 'WARNING') morningSegment.classList.add('warning');
        if (eqData.morning.prediction === 'FAULT') morningSegment.classList.add('fault');
    } else {
        morningStatus.textContent = 'Not Uploaded';
    }
    
    if (eqData?.afternoon) {
        afternoonSegment.classList.add('uploaded');
        afternoonStatus.textContent = `Uploaded - ${eqData.afternoon.prediction}`;
        if (eqData.afternoon.prediction === 'WARNING') afternoonSegment.classList.add('warning');
        if (eqData.afternoon.prediction === 'FAULT') afternoonSegment.classList.add('fault');
    } else {
        afternoonStatus.textContent = 'Not Uploaded';
    }
}

function updateEquipmentStatusCards(dayData) {
    // Update GP status card
    updateEquipmentCard('gp', dayData.gp);
    
    // Update LLZ status card
    updateEquipmentCard('llz', dayData.llz);
}

function updateEquipmentCard(type, eqData) {
    const statusIndicator = document.getElementById(`${type}StatusIndicator`);
    const systemStatus = document.getElementById(`${type}SystemStatus`);
    const anomalyRate = document.getElementById(`${type}AnomalyRate`);
    const rulValue = document.getElementById(`${type}RulValue`);
    const lastAnalysis = document.getElementById(`${type}LastAnalysis`);
    
    if (!statusIndicator) return;
    
    // Get the best available data (combined > afternoon > morning)
    const displayData = eqData?.combined || eqData?.afternoon || eqData?.morning;
    
    if (displayData) {
        const prediction = displayData.prediction;
        
        // Update status indicator
        statusIndicator.className = 'equipment-status-indicator';
        if (prediction === 'FAULT') {
            statusIndicator.classList.add('fault');
            statusIndicator.innerHTML = '<span class="status-dot"></span><span>Fault Detected</span>';
        } else if (prediction === 'WARNING') {
            statusIndicator.classList.add('warning');
            statusIndicator.innerHTML = '<span class="status-dot"></span><span>Warning</span>';
        } else {
            statusIndicator.classList.add('ok');
            statusIndicator.innerHTML = '<span class="status-dot"></span><span>Normal</span>';
        }
        
        // Update metrics
        if (systemStatus) systemStatus.textContent = prediction;
        if (anomalyRate) anomalyRate.textContent = displayData.alarmRate + '%';
        if (rulValue) rulValue.textContent = displayData.rul + ' hrs';
        if (lastAnalysis) {
            const date = displayData.timeRange?.end || 'N/A';
            lastAnalysis.textContent = date.split(' ')[0] || 'Today';
        }
    } else {
        // No data
        statusIndicator.className = 'equipment-status-indicator';
        statusIndicator.innerHTML = '<span class="status-dot idle"></span><span>No Data</span>';
        
        if (systemStatus) systemStatus.textContent = 'Idle';
        if (anomalyRate) anomalyRate.textContent = '--';
        if (rulValue) rulValue.textContent = '-- hrs';
        if (lastAnalysis) lastAnalysis.textContent = 'Never';
    }
}

function updateDashboardForDate(dayData, dateStr) {
    // Get selected equipment type data
    const eqType = AppState.selectedEquipmentType;
    const eqData = dayData[eqType] || { morning: null, afternoon: null, combined: null };
    
    // Determine which data to show (combined if available, otherwise most recent)
    let displayData = null;
    let coverage = 'none';
    
    if (eqData.combined) {
        displayData = eqData.combined;
        coverage = 'full';
    } else if (eqData.morning) {
        displayData = eqData.morning;
        coverage = 'morning';
    } else if (eqData.afternoon) {
        displayData = eqData.afternoon;
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
        'user-management': 'userManagementPage',
        'visualize': 'visualizePage'
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
        'user-management': 'User Management',
        'visualize': 'Data Visualization'
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
    
    const uploadCard = document.querySelector('.upload-card');
    const folderCard = document.getElementById('folderConnectionCard');
    const divider = document.querySelector('.upload-divider');
    
    if (uploadCard) uploadCard.style.display = 'block';
    if (folderCard) folderCard.style.display = 'block';
    if (divider) divider.style.display = 'flex';
    
    // If folder is connected, also refresh the folder view
    if (AppState.folderHandle) {
        scanConnectedFolder();
    }
}

// ============================================
// ANALYSIS WORKFLOW
// ============================================
async function startAnalysis() {
    if (AppState.currentFiles.length === 0) return;
    
    const uploadCard = document.querySelector('.upload-card');
    const folderCard = document.getElementById('folderConnectionCard');
    const divider = document.querySelector('.upload-divider');
    
    if (uploadCard) uploadCard.style.display = 'none';
    if (folderCard) folderCard.style.display = 'none';
    if (divider) divider.style.display = 'none';
    processingSection.style.display = 'block';
    resultsSection.style.display = 'none';
    
    updateSystemState('processing');
    
    const allResults = [];
    
    try {
        for (let i = 0; i < AppState.currentFiles.length; i++) {
            const file = AppState.currentFiles[i];
            const fileInfo = file.fileInfo;
            
            // Step 1: Upload
            updateProcessingStep(1, `Uploading ${file.name}...`);
            const uploadResult = await BackendAPI.uploadFile(file);
            
            // Step 2: Read and parse
            updateProcessingStep(2, `Parsing ${file.name}...`);
            const content = await readFileContent(file);
            const parsedData = await BackendAPI.parseLogFile(content);
            
            // Step 3: ML Inference
            updateProcessingStep(3, `Running inference on ${file.name}...`);
            const predictions = await BackendAPI.runMLInference(parsedData);
            
            // Step 4: Generate predictions
            updateProcessingStep(4, 'Finalizing predictions...');
            await BackendAPI.simulateDelay(500);
            
            // Step 5: Store results
            updateProcessingStep(5, 'Storing results...');
            const storeResult = await BackendAPI.storeResults(
                uploadResult.uploadId,
                parsedData,
                predictions,
                { filename: file.name, ...fileInfo }
            );
            
            allResults.push(storeResult.result);
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
    const history = DataStore.getUploadHistory().slice(0, 30);
    
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
function updateUploadHistory() {
    const history = DataStore.getUploadHistory();
    const historyList = document.getElementById('historyList');
    const historyCount = document.getElementById('historyCount');
    
    historyCount.textContent = `${history.length} files`;
    
    if (history.length === 0) {
        historyList.innerHTML = `
            <div class="empty-history">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="12" cy="12" r="10" stroke="#717182" stroke-width="2"/>
                    <path d="M12 6v6l4 2" stroke="#717182" stroke-width="2" stroke-linecap="round"/>
                </svg>
                <p>No upload history yet</p>
            </div>
        `;
        return;
    }
    
    historyList.innerHTML = history.slice(0, 20).map(h => `
        <div class="history-item">
            <div class="history-icon ${h.prediction.toLowerCase()}"></div>
            <div class="history-details">
                <span class="history-filename">${h.filename}</span>
                <span class="history-meta">${h.dateStr} • ${h.periodLabel || 'Unknown'}</span>
            </div>
            <span class="history-badge ${h.prediction.toLowerCase()}">${h.prediction === 'NORMAL' ? 'Normal' : h.prediction}</span>
        </div>
    `).join('');
}

// ============================================
// FAULT INSIGHTS
// ============================================
function updateFaultInsights() {
    const history = DataStore.getUploadHistory();
    
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
// FILE SYSTEM ACCESS API
// ============================================
const FileSystemAPI = {
    /**
     * Check if File System Access API is supported
     */
    isSupported() {
        return 'showDirectoryPicker' in window;
    },
    
    /**
     * Open folder picker dialog
     */
    async selectFolder() {
        if (!this.isSupported()) {
            throw new Error('File System Access API is not supported in this browser');
        }
        
        try {
            const handle = await window.showDirectoryPicker({
                mode: 'read'
            });
            return handle;
        } catch (err) {
            if (err.name === 'AbortError') {
                return null; // User cancelled
            }
            throw err;
        }
    },
    
    /**
     * Scan folder for compatible files
     */
    async scanFolder(dirHandle) {
        const files = [];
        const validExtensions = ['log', 'txt', 'csv'];
        
        async function* getFilesRecursively(dirHandle, path = '') {
            for await (const entry of dirHandle.values()) {
                if (entry.kind === 'file') {
                    const ext = entry.name.split('.').pop().toLowerCase();
                    if (validExtensions.includes(ext)) {
                        yield { handle: entry, path: path + entry.name };
                    }
                } else if (entry.kind === 'directory') {
                    // Optionally scan subdirectories (1 level deep)
                    // yield* getFilesRecursively(entry, path + entry.name + '/');
                }
            }
        }
        
        for await (const fileEntry of getFilesRecursively(dirHandle)) {
            try {
                const file = await fileEntry.handle.getFile();
                const fileInfo = BackendAPI.detectFilePeriod(file.name);
                files.push({
                    handle: fileEntry.handle,
                    name: file.name,
                    path: fileEntry.path,
                    size: file.size,
                    lastModified: file.lastModified,
                    fileInfo: fileInfo
                });
            } catch (err) {
                console.warn('Could not read file:', fileEntry.path, err);
            }
        }
        
        // Sort by date and period
        files.sort((a, b) => {
            if (a.fileInfo.dateStr !== b.fileInfo.dateStr) {
                return b.fileInfo.dateStr.localeCompare(a.fileInfo.dateStr); // Newest first
            }
            return a.fileInfo.period.localeCompare(b.fileInfo.period);
        });
        
        return files;
    },
    
    /**
     * Get File object from handle
     */
    async getFileFromHandle(fileHandle) {
        return await fileHandle.getFile();
    }
};

// ============================================
// WEBSOCKET FILE WATCHER CLIENT
// ============================================
const FileWatcherClient = {
    ws: null,
    serverUrl: 'ws://localhost:3000',
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
    reconnectDelay: 3000,
    isConnected: false,
    
    /**
     * Connect to the file watcher server
     */
    connect(serverUrl = null) {
        if (serverUrl) {
            this.serverUrl = serverUrl;
        }
        
        console.log(`[FileWatcher] Connecting to ${this.serverUrl}...`);
        
        try {
            this.ws = new WebSocket(this.serverUrl);
            
            this.ws.onopen = () => {
                console.log('[FileWatcher] Connected to server');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.updateConnectionUI(true);
            };
            
            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleMessage(data);
                } catch (err) {
                    console.error('[FileWatcher] Error parsing message:', err);
                }
            };
            
            this.ws.onclose = () => {
                console.log('[FileWatcher] Disconnected from server');
                this.isConnected = false;
                this.updateConnectionUI(false);
                this.attemptReconnect();
            };
            
            this.ws.onerror = (err) => {
                console.error('[FileWatcher] WebSocket error:', err);
            };
            
        } catch (err) {
            console.error('[FileWatcher] Connection error:', err);
            this.updateConnectionUI(false);
        }
    },
    
    /**
     * Disconnect from server
     */
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
        this.reconnectAttempts = this.maxReconnectAttempts; // Prevent auto-reconnect
        this.updateConnectionUI(false);
    },
    
    /**
     * Attempt to reconnect
     */
    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log('[FileWatcher] Max reconnection attempts reached');
            return;
        }
        
        this.reconnectAttempts++;
        console.log(`[FileWatcher] Reconnecting in ${this.reconnectDelay/1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        
        setTimeout(() => {
            if (!this.isConnected) {
                this.connect();
            }
        }, this.reconnectDelay);
    },
    
    /**
     * Send message to server
     */
    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        } else {
            console.warn('[FileWatcher] Cannot send message - not connected');
        }
    },
    
    /**
     * Request file list from server
     */
    requestFiles() {
        this.send({ type: 'get-files' });
    },
    
    /**
     * Request file content
     */
    requestFileContent(filename) {
        this.send({ type: 'get-file-content', filename });
    },
    
    /**
     * Request rescan
     */
    requestRescan() {
        this.send({ type: 'rescan' });
    },
    
    /**
     * Handle incoming messages from server
     */
    handleMessage(data) {
        console.log('[FileWatcher] Received:', data.type);
        
        switch (data.type) {
            case 'connected':
                console.log('[FileWatcher] Server info:', data.watchFolder);
                AppState.serverWatchFolder = data.watchFolder;
                if (data.files) {
                    this.updateFilesFromServer(data.files);
                }
                break;
                
            case 'watcher-ready':
            case 'file-list':
                this.updateFilesFromServer(data.files);
                break;
                
            case 'file-added':
                console.log('[FileWatcher] File added:', data.file.filename);
                showToast(`New file detected: ${data.file.filename}`, 'success');
                this.updateFilesFromServer(data.allFiles);
                break;
                
            case 'file-changed':
                console.log('[FileWatcher] File changed:', data.file.filename);
                showToast(`File updated: ${data.file.filename}`, 'info');
                this.updateFilesFromServer(data.allFiles);
                break;
                
            case 'file-removed':
                console.log('[FileWatcher] File removed:', data.filename);
                showToast(`File removed: ${data.filename}`, 'warning');
                this.updateFilesFromServer(data.allFiles);
                break;
                
            case 'file-content':
                this.handleFileContent(data.filename, data.content);
                break;
                
            case 'error':
                console.error('[FileWatcher] Server error:', data.message);
                showToast(`Server error: ${data.message}`, 'error');
                break;
                
            case 'watcher-error':
                console.error('[FileWatcher] Watcher error:', data.message);
                showToast(`Watcher error: ${data.message}`, 'error');
                break;
        }
    },
    
    /**
     * Update detected files from server data
     */
    updateFilesFromServer(files) {
        // Convert server file format to match our expected format
        AppState.detectedFiles = files.map(f => ({
            name: f.filename,
            path: f.path,
            size: f.size,
            lastModified: f.lastModified,
            fileInfo: {
                dateStr: f.dateStr,
                period: f.period,
                periodLabel: f.periodLabel
            },
            equipmentType: f.equipmentType || 'gp',
            equipmentLabel: f.equipmentLabel || 'Glide Path (GP)',
            equipmentShort: f.equipmentShort || 'GP',
            isUploaded: isFileUploaded(f.filename, f.dateStr, f.period, f.equipmentType),
            serverFile: true // Mark as coming from server
        }));
        
        AppState.lastScanTime = new Date();
        
        // Update UI
        renderDetectedFilesFromServer();
    },
    
    /**
     * Handle file content received from server
     */
    handleFileContent(filename, content) {
        // Store content temporarily for analysis
        AppState.pendingFileContent = {
            filename,
            content
        };
        
        // Trigger analysis if we were waiting for this
        if (AppState.awaitingFileContent === filename) {
            AppState.awaitingFileContent = null;
            processFileContentFromServer(filename, content);
        }
    },
    
    /**
     * Update connection status UI
     */
    updateConnectionUI(connected) {
        const statusEl = document.getElementById('serverConnectionStatus');
        const connectBtn = document.getElementById('connectServerBtn');
        const disconnectBtn = document.getElementById('disconnectServerBtn');
        
        if (statusEl) {
            if (connected) {
                statusEl.innerHTML = '<span class="connection-dot connected"></span> Connected to server';
                statusEl.className = 'server-status connected';
            } else {
                statusEl.innerHTML = '<span class="connection-dot disconnected"></span> Not connected';
                statusEl.className = 'server-status disconnected';
            }
        }
        
        if (connectBtn) connectBtn.style.display = connected ? 'none' : 'inline-flex';
        if (disconnectBtn) disconnectBtn.style.display = connected ? 'inline-flex' : 'none';
    }
};

/**
 * Render files received from the server
 */
function renderDetectedFilesFromServer() {
    const filesByDate = document.getElementById('filesByDate');
    const files = AppState.detectedFiles;
    
    // Update last scan time
    const lastScanEl = document.getElementById('lastScanTime');
    if (lastScanEl && AppState.lastScanTime) {
        lastScanEl.textContent = `Last update: ${AppState.lastScanTime.toLocaleTimeString()}`;
    }
    
    if (!files || files.length === 0) {
        filesByDate.innerHTML = `
            <div class="empty-folder-message">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M22 19C22 19.5304 21.7893 20.0391 21.4142 20.4142C21.0391 20.7893 20.5304 21 20 21H4C3.46957 21 2.96086 20.7893 2.58579 20.4142C2.21071 20.0391 2 19.5304 2 19V5C2 4.46957 2.21071 3.96086 2.58579 3.58579C2.96086 3.21071 3.46957 3 4 3H9L11 6H20C20.5304 6 21.0391 6.21071 21.4142 6.58579C21.7893 6.96086 22 7.46957 22 8V19Z" stroke="#717182" stroke-width="2"/>
                </svg>
                <p>No compatible files found</p>
                <span>Watching for .log, .txt, .csv files</span>
            </div>
        `;
        document.getElementById('totalDetectedFiles').textContent = '0 files found';
        document.getElementById('newFilesCount').textContent = '0 new';
        document.getElementById('bulkActions').style.display = 'none';
        return;
    }
    
    // Group files by date
    const groupedByDate = {};
    let newFilesCount = 0;
    
    files.forEach(file => {
        const dateStr = file.fileInfo.dateStr;
        if (!groupedByDate[dateStr]) {
            groupedByDate[dateStr] = [];
        }
        if (!file.isUploaded) newFilesCount++;
        groupedByDate[dateStr].push(file);
    });
    
    // Update stats
    document.getElementById('totalDetectedFiles').textContent = `${files.length} files found`;
    document.getElementById('newFilesCount').textContent = `${newFilesCount} new`;
    document.getElementById('newFilesCountBtn').textContent = newFilesCount;
    
    // Show/hide bulk action
    document.getElementById('bulkActions').style.display = newFilesCount > 0 ? 'block' : 'none';
    
    // Render groups
    const sortedDates = Object.keys(groupedByDate).sort().reverse();
    
    filesByDate.innerHTML = sortedDates.map(dateStr => {
        const dateFiles = groupedByDate[dateStr];
        const uploadedCount = dateFiles.filter(f => f.isUploaded).length;
        const date = new Date(dateStr + 'T12:00:00');
        const formattedDate = date.toLocaleDateString('en-US', { 
            weekday: 'short', 
            year: 'numeric', 
            month: 'short', 
            day: 'numeric' 
        });
        
        return `
            <div class="date-group">
                <div class="date-group-header">
                    <div class="date-group-title">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"/>
                            <line x1="16" y1="2" x2="16" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                            <line x1="8" y1="2" x2="8" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                            <line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="2"/>
                        </svg>
                        <span>${formattedDate}</span>
                    </div>
                    <span class="date-group-meta">${dateFiles.length} files • ${uploadedCount} uploaded</span>
                </div>
                <div class="date-group-files">
                    ${dateFiles.map((file, idx) => renderServerFileItem(file)).join('')}
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Render a single file item from server
 */
function renderServerFileItem(file) {
    const periodClass = file.fileInfo.period;
    const periodLabel = file.fileInfo.periodLabel;
    const statusClass = file.isUploaded ? 'uploaded' : 'new';
    const statusLabel = file.isUploaded ? 'Uploaded' : 'New';
    const buttonText = file.isUploaded ? '✓ Done' : 'Analyze';
    const buttonClass = file.isUploaded ? 'btn-analyze-file uploaded' : 'btn-analyze-file';
    const buttonDisabled = file.isUploaded ? 'disabled' : '';
    
    // Equipment type badge
    const eqType = file.equipmentType || 'gp';
    const eqLabel = file.equipmentShort || (eqType === 'llz' ? 'LLZ' : 'GP');
    const eqClass = eqType === 'llz' ? 'llz' : 'gp';
    
    return `
        <div class="detected-file-item ${file.isUploaded ? 'uploaded' : ''}">
            <div class="file-equipment-badge ${eqClass}">${eqLabel}</div>
            <div class="file-period-indicator ${periodClass}"></div>
            <div class="detected-file-info">
                <span class="detected-file-name">${file.name}</span>
                <span class="detected-file-meta">
                    ${formatFileSize(file.size)} • ${periodLabel}
                    <span class="file-status-badge ${statusClass}">${statusLabel}</span>
                </span>
            </div>
            <button class="${buttonClass}" ${buttonDisabled} onclick="analyzeServerFile('${file.name}')">
                ${buttonText}
            </button>
        </div>
    `;
}

/**
 * Analyze a file from the server
 */
async function analyzeServerFile(filename) {
    const fileEntry = AppState.detectedFiles.find(f => f.name === filename);
    if (!fileEntry || fileEntry.isUploaded) return;
    
    try {
        // Fetch file content from server
        const response = await fetch(`/api/files/${encodeURIComponent(filename)}/content`);
        if (!response.ok) {
            throw new Error('Failed to fetch file content');
        }
        const content = await response.text();
        
        // Create a mock File object with the content
        const blob = new Blob([content], { type: 'text/plain' });
        const file = new File([blob], filename, { type: 'text/plain' });
        file.fileInfo = fileEntry.fileInfo;
        
        // Add to current files and start analysis
        AppState.currentFiles = [file];
        await startAnalysis();
        
        // Refresh the file list
        if (FileWatcherClient.isConnected) {
            FileWatcherClient.requestFiles();
        }
        
    } catch (err) {
        console.error('Error analyzing file:', err);
        showToast('Error analyzing file: ' + err.message, 'error');
    }
}

/**
 * Analyze all new files from server
 */
async function analyzeAllServerFiles() {
    const newFiles = AppState.detectedFiles.filter(f => !f.isUploaded);
    if (newFiles.length === 0) {
        showToast('No new files to analyze', 'info');
        return;
    }
    
    try {
        const filesToAnalyze = [];
        
        for (const fileEntry of newFiles) {
            const response = await fetch(`/api/files/${encodeURIComponent(fileEntry.name)}/content`);
            if (!response.ok) {
                console.warn(`Failed to fetch ${fileEntry.name}`);
                continue;
            }
            const content = await response.text();
            
            const blob = new Blob([content], { type: 'text/plain' });
            const file = new File([blob], fileEntry.name, { type: 'text/plain' });
            file.fileInfo = fileEntry.fileInfo;
            filesToAnalyze.push(file);
        }
        
        if (filesToAnalyze.length === 0) {
            showToast('Could not load any files', 'error');
            return;
        }
        
        AppState.currentFiles = filesToAnalyze;
        await startAnalysis();
        
        // Refresh the file list
        if (FileWatcherClient.isConnected) {
            FileWatcherClient.requestFiles();
        }
        
    } catch (err) {
        console.error('Error analyzing files:', err);
        showToast('Error analyzing files: ' + err.message, 'error');
    }
}

// Make functions globally accessible
window.analyzeServerFile = analyzeServerFile;
window.analyzeAllServerFiles = analyzeAllServerFiles;

/**
 * Check if a file has already been uploaded
 */
function isFileUploaded(filename, dateStr, period, equipmentType = null) {
    const history = DataStore.getUploadHistory();
    return history.some(h => 
        h.filename === filename && 
        h.dateStr === dateStr && 
        h.period === period &&
        (equipmentType === null || h.equipmentType === equipmentType)
    );
}

/**
 * Switch between connection tabs (server/browser)
 */
function switchConnectionTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.connection-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    
    // Update tab content
    document.getElementById('serverTabContent').classList.toggle('active', tabName === 'server');
    document.getElementById('browserTabContent').classList.toggle('active', tabName === 'browser');
}

// Make function globally accessible
window.switchConnectionTab = switchConnectionTab;

/**
 * Initialize folder connection UI
 */
function initializeFolderConnection() {
    // Check if elements exist (they won't be visible until user navigates to Data Upload page)
    const badge = document.getElementById('apiCompatibilityBadge');
    const connectBtn = document.getElementById('connectFolderBtn');
    const disconnectBtn = document.getElementById('disconnectFolderBtn');
    const rescanBtn = document.getElementById('rescanFolderBtn');
    const autoScanToggle = document.getElementById('autoScanToggle');
    const analyzeAllBtn = document.getElementById('analyzeAllNewBtn');
    
    // Server connection elements
    const connectServerBtn = document.getElementById('connectServerBtn');
    const disconnectServerBtn = document.getElementById('disconnectServerBtn');
    
    // Guard against missing elements
    if (!badge || !connectBtn) {
        console.warn('Folder connection elements not found in DOM');
        return;
    }
    
    // Check API support
    if (FileSystemAPI.isSupported()) {
        badge.classList.add('supported');
        badge.innerHTML = '<span class="compat-icon">✓</span><span class="compat-text">Browser supported</span>';
    } else {
        badge.classList.add('unsupported');
        badge.innerHTML = '<span class="compat-icon">✗</span><span class="compat-text">Not supported (use Chrome/Edge)</span>';
        connectBtn.disabled = true;
    }
    
    // Add event listeners with null checks
    if (connectBtn) connectBtn.addEventListener('click', handleConnectFolder);
    if (disconnectBtn) disconnectBtn.addEventListener('click', handleDisconnectFolder);
    if (rescanBtn) rescanBtn.addEventListener('click', handleRescanFolder);
    if (autoScanToggle) autoScanToggle.addEventListener('change', handleAutoScanToggle);
    if (analyzeAllBtn) analyzeAllBtn.addEventListener('click', handleAnalyzeAllNew);
    
    // Server connection event listeners
    if (connectServerBtn) connectServerBtn.addEventListener('click', handleConnectServer);
    if (disconnectServerBtn) disconnectServerBtn.addEventListener('click', handleDisconnectServer);
    
    // Try to auto-connect to server if running on localhost
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        setTimeout(() => {
            FileWatcherClient.connect();
        }, 1000);
    }
}

/**
 * Handle connect to server button click
 */
function handleConnectServer() {
    const serverUrl = document.getElementById('serverUrlInput')?.value || 'ws://localhost:3000';
    FileWatcherClient.connect(serverUrl);
}

/**
 * Handle disconnect from server
 */
function handleDisconnectServer() {
    FileWatcherClient.disconnect();
}

/**
 * Handle connect folder button click
 */
async function handleConnectFolder() {
    try {
        const handle = await FileSystemAPI.selectFolder();
        if (!handle) return; // User cancelled
        
        AppState.folderHandle = handle;
        
        // Show connected state
        document.getElementById('folderNotConnected').style.display = 'none';
        document.getElementById('folderConnected').style.display = 'block';
        document.getElementById('connectedFolderName').textContent = handle.name;
        
        // Scan folder
        await scanConnectedFolder();
        
        showToast(`Connected to folder: ${handle.name}`, 'success');
        
    } catch (err) {
        console.error('Error connecting folder:', err);
        showToast('Failed to connect folder: ' + err.message, 'error');
    }
}

/**
 * Handle disconnect folder
 */
function handleDisconnectFolder() {
    AppState.folderHandle = null;
    AppState.detectedFiles = [];
    
    // Stop auto-scan if running
    if (AppState.autoScanInterval) {
        clearInterval(AppState.autoScanInterval);
        AppState.autoScanInterval = null;
    }
    AppState.autoScanEnabled = false;
    document.getElementById('autoScanToggle').checked = false;
    
    // Reset UI
    document.getElementById('folderNotConnected').style.display = 'block';
    document.getElementById('folderConnected').style.display = 'none';
    
    showToast('Folder disconnected', 'info');
}

/**
 * Handle rescan folder
 */
async function handleRescanFolder() {
    if (!AppState.folderHandle) return;
    await scanConnectedFolder();
    showToast('Folder rescanned', 'success');
}

/**
 * Handle auto-scan toggle
 */
function handleAutoScanToggle(e) {
    AppState.autoScanEnabled = e.target.checked;
    
    if (AppState.autoScanEnabled) {
        // Start auto-scan every 5 minutes
        AppState.autoScanInterval = setInterval(async () => {
            if (AppState.folderHandle && !AppState.isScanning) {
                console.log('[Auto-scan] Running scheduled scan...');
                await scanConnectedFolder();
            }
        }, 5 * 60 * 1000); // 5 minutes
        
        showToast('Auto-scan enabled (every 5 minutes)', 'success');
    } else {
        // Stop auto-scan
        if (AppState.autoScanInterval) {
            clearInterval(AppState.autoScanInterval);
            AppState.autoScanInterval = null;
        }
        showToast('Auto-scan disabled', 'info');
    }
}

/**
 * Scan connected folder and update UI
 */
async function scanConnectedFolder() {
    if (!AppState.folderHandle || AppState.isScanning) return;
    
    AppState.isScanning = true;
    const filesByDate = document.getElementById('filesByDate');
    
    // Show scanning indicator
    filesByDate.innerHTML = `
        <div class="scanning-indicator">
            <div class="scanning-spinner"></div>
            <span class="scanning-text">Scanning folder for datalog files...</span>
        </div>
    `;
    
    try {
        const files = await FileSystemAPI.scanFolder(AppState.folderHandle);
        AppState.detectedFiles = files;
        AppState.lastScanTime = new Date();
        
        // Update last scan time display
        document.getElementById('lastScanTime').textContent = 
            `Last scan: ${AppState.lastScanTime.toLocaleTimeString()}`;
        
        // Update UI
        renderDetectedFiles();
        
    } catch (err) {
        console.error('Error scanning folder:', err);
        filesByDate.innerHTML = `
            <div class="empty-folder-message">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="12" cy="12" r="10" stroke="#DC2626" stroke-width="2"/>
                    <line x1="15" y1="9" x2="9" y2="15" stroke="#DC2626" stroke-width="2"/>
                    <line x1="9" y1="9" x2="15" y2="15" stroke="#DC2626" stroke-width="2"/>
                </svg>
                <p>Error scanning folder</p>
                <span>${err.message}</span>
            </div>
        `;
        showToast('Error scanning folder: ' + err.message, 'error');
    } finally {
        AppState.isScanning = false;
    }
}

/**
 * Render detected files grouped by date
 */
function renderDetectedFiles() {
    const filesByDate = document.getElementById('filesByDate');
    const files = AppState.detectedFiles;
    
    if (files.length === 0) {
        filesByDate.innerHTML = `
            <div class="empty-folder-message">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M22 19C22 19.5304 21.7893 20.0391 21.4142 20.4142C21.0391 20.7893 20.5304 21 20 21H4C3.46957 21 2.96086 20.7893 2.58579 20.4142C2.21071 20.0391 2 19.5304 2 19V5C2 4.46957 2.21071 3.96086 2.58579 3.58579C2.96086 3.21071 3.46957 3 4 3H9L11 6H20C20.5304 6 21.0391 6.21071 21.4142 6.58579C21.7893 6.96086 22 7.46957 22 8V19Z" stroke="#717182" stroke-width="2"/>
                </svg>
                <p>No compatible files found in this folder</p>
                <span>Looking for .log, .txt, .csv files</span>
            </div>
        `;
        document.getElementById('totalDetectedFiles').textContent = '0 files found';
        document.getElementById('newFilesCount').textContent = '0 new';
        document.getElementById('bulkActions').style.display = 'none';
        return;
    }
    
    // Group files by date
    const groupedByDate = {};
    let newFilesCount = 0;
    
    files.forEach(file => {
        const dateStr = file.fileInfo.dateStr;
        if (!groupedByDate[dateStr]) {
            groupedByDate[dateStr] = [];
        }
        
        // Check if uploaded
        const uploaded = isFileUploaded(file.name, dateStr, file.fileInfo.period);
        file.isUploaded = uploaded;
        if (!uploaded) newFilesCount++;
        
        groupedByDate[dateStr].push(file);
    });
    
    // Update stats
    document.getElementById('totalDetectedFiles').textContent = `${files.length} files found`;
    document.getElementById('newFilesCount').textContent = `${newFilesCount} new`;
    document.getElementById('newFilesCountBtn').textContent = newFilesCount;
    
    // Show/hide bulk action
    document.getElementById('bulkActions').style.display = newFilesCount > 0 ? 'block' : 'none';
    
    // Render groups
    const sortedDates = Object.keys(groupedByDate).sort().reverse();
    
    filesByDate.innerHTML = sortedDates.map(dateStr => {
        const dateFiles = groupedByDate[dateStr];
        const uploadedCount = dateFiles.filter(f => f.isUploaded).length;
        const date = new Date(dateStr + 'T12:00:00');
        const formattedDate = date.toLocaleDateString('en-US', { 
            weekday: 'short', 
            year: 'numeric', 
            month: 'short', 
            day: 'numeric' 
        });
        
        return `
            <div class="date-group">
                <div class="date-group-header">
                    <div class="date-group-title">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"/>
                            <line x1="16" y1="2" x2="16" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                            <line x1="8" y1="2" x2="8" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                            <line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="2"/>
                        </svg>
                        <span>${formattedDate}</span>
                    </div>
                    <span class="date-group-meta">${dateFiles.length} files • ${uploadedCount} uploaded</span>
                </div>
                <div class="date-group-files">
                    ${dateFiles.map((file, idx) => renderDetectedFileItem(file, idx)).join('')}
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Render a single detected file item
 */
function renderDetectedFileItem(file, index) {
    const periodClass = file.fileInfo.period;
    const periodLabel = file.fileInfo.periodLabel;
    const statusClass = file.isUploaded ? 'uploaded' : 'new';
    const statusLabel = file.isUploaded ? 'Uploaded' : 'New';
    const buttonText = file.isUploaded ? '✓ Done' : 'Analyze';
    const buttonClass = file.isUploaded ? 'btn-analyze-file uploaded' : 'btn-analyze-file';
    const buttonDisabled = file.isUploaded ? 'disabled' : '';
    
    return `
        <div class="detected-file-item ${file.isUploaded ? 'uploaded' : ''}">
            <div class="file-period-indicator ${periodClass}"></div>
            <div class="detected-file-info">
                <span class="detected-file-name">${file.name}</span>
                <span class="detected-file-meta">
                    ${formatFileSize(file.size)} • ${periodLabel}
                    <span class="file-status-badge ${statusClass}">${statusLabel}</span>
                </span>
            </div>
            <button class="${buttonClass}" ${buttonDisabled} onclick="analyzeDetectedFile('${file.name}')">
                ${buttonText}
            </button>
        </div>
    `;
}

/**
 * Analyze a single detected file
 */
async function analyzeDetectedFile(filename) {
    const fileEntry = AppState.detectedFiles.find(f => f.name === filename);
    if (!fileEntry || fileEntry.isUploaded) return;
    
    try {
        const file = await FileSystemAPI.getFileFromHandle(fileEntry.handle);
        file.fileInfo = fileEntry.fileInfo;
        
        // Add to current files and start analysis
        AppState.currentFiles = [file];
        await startAnalysis();
        
        // Refresh the detected files list
        await scanConnectedFolder();
        
    } catch (err) {
        console.error('Error analyzing file:', err);
        showToast('Error analyzing file: ' + err.message, 'error');
    }
}

/**
 * Analyze all new (not uploaded) files - handles both server and browser modes
 */
async function handleAnalyzeAllNew() {
    // Check if files came from server or browser
    const hasServerFiles = AppState.detectedFiles.some(f => f.serverFile);
    
    if (hasServerFiles || FileWatcherClient.isConnected) {
        // Use server mode
        await analyzeAllServerFiles();
    } else {
        // Use browser File System Access API mode
        const newFiles = AppState.detectedFiles.filter(f => !f.isUploaded);
        if (newFiles.length === 0) {
            showToast('No new files to analyze', 'info');
            return;
        }
        
        try {
            // Get actual File objects for all new files
            const filesToAnalyze = [];
            for (const fileEntry of newFiles) {
                if (fileEntry.handle) {
                    const file = await FileSystemAPI.getFileFromHandle(fileEntry.handle);
                    file.fileInfo = fileEntry.fileInfo;
                    filesToAnalyze.push(file);
                }
            }
            
            if (filesToAnalyze.length === 0) {
                showToast('Could not load any files', 'error');
                return;
            }
            
            // Add to current files and start analysis
            AppState.currentFiles = filesToAnalyze;
            await startAnalysis();
            
            // Refresh the detected files list
            await scanConnectedFolder();
            
        } catch (err) {
            console.error('Error analyzing files:', err);
            showToast('Error analyzing files: ' + err.message, 'error');
        }
    }
}

// Make functions globally accessible
window.analyzeDetectedFile = analyzeDetectedFile;

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

// ============================================
// DATA VISUALIZATION MODULE
// ============================================
const VisualizationManager = {
    // Store processed data from server
    processedData: null,
    availableColumns: [],
    charts: new Map(), // chartId -> Chart instance
    chartCounter: 0,
    
    /**
     * Initialize visualization module
     */
    init() {
        // Set up event listeners
        const addGraphBtn = document.getElementById('addGraphBtn');
        const parameterSelect = document.getElementById('parameterSelect');
        
        if (addGraphBtn) {
            addGraphBtn.addEventListener('click', () => this.addGraph());
        }
        
        if (parameterSelect) {
            parameterSelect.addEventListener('change', () => {
                const addBtn = document.getElementById('addGraphBtn');
                if (addBtn) {
                    addBtn.disabled = !parameterSelect.value;
                }
            });
        }
        
        // Auto-load data on init
        this.loadDataFromServer();
        
        console.log('[Visualization] Module initialized');
    },
    
    /**
     * Load data from server via HTTP fetch
     */
    async loadDataFromServer() {
        const loadBtn = document.getElementById('loadDataBtn');
        if (loadBtn) {
            loadBtn.disabled = true;
            loadBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-dasharray="30" stroke-dashoffset="10"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg> Loading...';
        }
        
        try {
            const response = await fetch('/api/processed-data');
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            console.log('[Visualization] Loaded data from server:', data?.metadata);
            
            this.handleProcessedData(data);
            showToast(`Loaded ${data?.metadata?.total_records || 0} records`, 'success');
            
        } catch (error) {
            console.error('[Visualization] Failed to load data:', error);
            showToast('Failed to load data. Make sure the server is running and data_processor.py has run.', 'error');
        } finally {
            if (loadBtn) {
                loadBtn.disabled = false;
                loadBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><polyline points="7 10 12 15 17 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Load Data';
            }
        }
    },
    
    /**
     * Handle processed data update from server
     */
    handleProcessedData(data) {
        console.log('[Visualization] Received processed data:', data?.metadata);
        
        this.processedData = data;
        
        if (data && data.metadata) {
            this.availableColumns = data.metadata.columns || [];
            this.updateUI(data.metadata);
            this.populateParameterDropdown();
            this.populateDateDropdown();
        }
    },
    
    /**
     * Populate the date dropdown with available dates
     */
    populateDateDropdown() {
        const dateSelect = document.getElementById('vizDateFilter');
        if (!dateSelect || !this.processedData || !this.processedData.records) return;
        
        // Extract unique dates from records
        const dates = new Set();
        this.processedData.records.forEach(record => {
            if (record._date) {
                dates.add(record._date);
            }
        });
        
        // Sort dates descending (newest first)
        const sortedDates = Array.from(dates).sort().reverse();
        
        // Clear and populate dropdown
        dateSelect.innerHTML = '<option value="all">All Dates</option>';
        
        sortedDates.forEach(date => {
            const option = document.createElement('option');
            option.value = date;
            option.textContent = date;
            dateSelect.appendChild(option);
        });
        
        // Auto-select the first (most recent) date if available
        if (sortedDates.length > 0) {
            dateSelect.value = sortedDates[0];
        }
        
        console.log(`[Visualization] Populated ${sortedDates.length} dates`);
    },
    
    /**
     * Get current filter values
     */
    getFilters() {
        return {
            date: document.getElementById('vizDateFilter')?.value || 'all',
            period: document.getElementById('vizPeriodFilter')?.value || 'all',
            equipment: document.getElementById('equipmentFilter')?.value || 'all'
        };
    },
    
    /**
     * Filter records based on current filter settings
     */
    filterRecords(records) {
        const filters = this.getFilters();
        
        return records.filter(record => {
            // Date filter
            if (filters.date !== 'all' && record._date !== filters.date) {
                return false;
            }
            
            // Period filter
            if (filters.period !== 'all' && record._period !== filters.period) {
                return false;
            }
            
            // Equipment filter
            if (filters.equipment !== 'all' && record._equipment_type !== filters.equipment) {
                return false;
            }
            
            return true;
        });
    },
    
    /**
     * Clear all graphs
     */
    clearAllGraphs() {
        // Destroy all chart instances
        this.charts.forEach((chart, chartId) => {
            chart.destroy();
        });
        this.charts.clear();
        
        // Remove all chart cards from DOM
        const container = document.getElementById('vizGraphsContainer');
        if (container) {
            container.querySelectorAll('.viz-graph-card').forEach(card => card.remove());
        }
        
        // Show empty state
        const emptyState = document.getElementById('vizEmptyState');
        if (emptyState) emptyState.style.display = 'flex';
        
        showToast('All graphs cleared', 'info');
    },
    
    /**
     * Update UI with data statistics
     */
    updateUI(metadata) {
        const statusCard = document.getElementById('vizStatusCard');
        const statusTitle = document.getElementById('vizStatusTitle');
        const statusMessage = document.getElementById('vizStatusMessage');
        const recordCount = document.getElementById('vizRecordCount');
        const columnCount = document.getElementById('vizColumnCount');
        const fileCount = document.getElementById('vizFileCount');
        
        if (metadata.total_records > 0) {
            if (statusCard) statusCard.classList.add('has-data');
            if (statusTitle) statusTitle.textContent = 'Data Loaded';
            if (statusMessage) statusMessage.textContent = `Last updated: ${new Date(metadata.processed_at).toLocaleString()}`;
        } else {
            if (statusCard) statusCard.classList.remove('has-data');
            if (statusTitle) statusTitle.textContent = 'No Data Loaded';
            if (statusMessage) statusMessage.textContent = 'Run the Python data processor to load data.';
        }
        
        if (recordCount) recordCount.textContent = (metadata.total_records || 0).toLocaleString();
        if (columnCount) columnCount.textContent = (metadata.columns?.length || 0).toLocaleString();
        if (fileCount) fileCount.textContent = (metadata.file_count || 0).toLocaleString();
    },
    
    /**
     * Populate the parameter dropdown with available columns
     */
    populateParameterDropdown() {
        const select = document.getElementById('parameterSelect');
        if (!select) return;
        
        // Clear existing options
        select.innerHTML = '';
        
        // Filter out metadata columns (starting with _) and timestamp
        const dataColumns = this.availableColumns.filter(col => 
            !col.startsWith('_') && col !== 'timestamp'
        );
        
        if (dataColumns.length === 0) {
            select.innerHTML = '<option value="">-- No data columns available --</option>';
            return;
        }
        
        // Add default option
        select.innerHTML = '<option value="">-- Select a parameter --</option>';
        
        // Group columns by monitor (MON1, MON2, STB, etc.)
        const groups = {};
        dataColumns.forEach(col => {
            const match = col.match(/^(MON\d+|STB|TX)/i);
            const group = match ? match[1].toUpperCase() : 'Other';
            if (!groups[group]) groups[group] = [];
            groups[group].push(col);
        });
        
        // Add grouped options
        Object.keys(groups).sort().forEach(groupName => {
            const optgroup = document.createElement('optgroup');
            optgroup.label = groupName;
            
            groups[groupName].sort().forEach(col => {
                const option = document.createElement('option');
                option.value = col;
                option.textContent = this.formatColumnName(col);
                optgroup.appendChild(option);
            });
            
            select.appendChild(optgroup);
        });
        
        // Enable add button if we have columns
        const addBtn = document.getElementById('addGraphBtn');
        if (addBtn) addBtn.disabled = true; // Will enable when user selects
    },
    
    /**
     * Format column name for display
     */
    formatColumnName(col) {
        // Convert MON1_CL_DDM_uA to MON1 CL DDM (µA)
        return col
            .replace(/_uA/g, ' (µA)')
            .replace(/_pct/g, ' (%)')
            .replace(/_V/g, ' (V)')
            .replace(/_kHz/g, ' (kHz)')
            .replace(/_deg/g, ' (°)')
            .replace(/_/g, ' ');
    },
    
    /**
     * Add a new graph
     */
    addGraph(columnOverride = null) {
        const paramSelect = document.getElementById('parameterSelect');
        const chartTypeSelect = document.getElementById('chartTypeSelect');
        const equipmentFilter = document.getElementById('equipmentFilter');
        
        const column = columnOverride || (paramSelect ? paramSelect.value : null);
        const chartType = chartTypeSelect ? chartTypeSelect.value : 'line';
        const equipment = equipmentFilter ? equipmentFilter.value : 'all';
        
        if (!column) {
            showToast('Please select a parameter', 'warning');
            return;
        }
        
        if (!this.processedData || !this.processedData.records) {
            showToast('No data available', 'error');
            return;
        }
        
        // Hide empty state
        const emptyState = document.getElementById('vizEmptyState');
        if (emptyState) emptyState.style.display = 'none';
        
        // Create chart card
        const chartId = `viz-chart-${++this.chartCounter}`;
        const chartCard = this.createChartCard(chartId, column, equipment, chartType);
        
        // Add to container
        const container = document.getElementById('vizGraphsContainer');
        if (container) {
            container.appendChild(chartCard);
        }
        
        // Render chart
        this.renderChart(chartId, column, equipment, chartType);
        
        // Reset dropdown
        if (paramSelect && !columnOverride) {
            paramSelect.value = '';
            const addBtn = document.getElementById('addGraphBtn');
            if (addBtn) addBtn.disabled = true;
        }
        
        showToast(`Added graph: ${this.formatColumnName(column)}`, 'success');
    },
    
    /**
     * Create a chart card element
     */
    createChartCard(chartId, column, equipment, chartType) {
        const card = document.createElement('div');
        card.className = 'viz-graph-card';
        card.id = `${chartId}-card`;
        
        const filters = this.getFilters();
        const equipmentBadge = filters.equipment === 'all' ? 'all' : filters.equipment.toLowerCase();
        const equipmentLabel = filters.equipment === 'all' ? 'All' : filters.equipment;
        
        // Build filter info string
        let filterInfo = [];
        if (filters.date !== 'all') filterInfo.push(filters.date);
        if (filters.period !== 'all') filterInfo.push(filters.period === 'morning' ? 'Morning' : 'Afternoon');
        const filterText = filterInfo.length > 0 ? filterInfo.join(' • ') : 'All Data';
        
        card.innerHTML = `
            <div class="viz-graph-header">
                <div class="viz-graph-title">
                    <h4>${this.formatColumnName(column)}</h4>
                    <span class="viz-graph-badge ${equipmentBadge}">${equipmentLabel}</span>
                    <span class="viz-graph-filter-info">${filterText}</span>
                </div>
                <div class="viz-graph-actions">
                    <button class="viz-graph-btn" onclick="VisualizationManager.toggleChartType('${chartId}')" title="Toggle chart type">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M18 20V10M12 20V4M6 20V14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </button>
                    <button class="viz-graph-btn remove" onclick="VisualizationManager.removeGraph('${chartId}')" title="Remove graph">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                            <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="viz-graph-body">
                <canvas id="${chartId}"></canvas>
            </div>
            <div class="viz-graph-footer">
                <div class="viz-graph-stats" id="${chartId}-stats">
                    <span class="viz-graph-stat">Points: <strong>--</strong></span>
                    <span class="viz-graph-stat">Min: <strong>--</strong></span>
                    <span class="viz-graph-stat">Max: <strong>--</strong></span>
                    <span class="viz-graph-stat">Avg: <strong>--</strong></span>
                </div>
                <span class="viz-graph-time" id="${chartId}-time">--</span>
            </div>
        `;
        
        // Store metadata including filters
        card.dataset.column = column;
        card.dataset.equipment = filters.equipment;
        card.dataset.chartType = chartType;
        card.dataset.date = filters.date;
        card.dataset.period = filters.period;
        
        return card;
    },
    
    /**
     * Render chart with data
     */
    renderChart(chartId, column, equipment, chartType) {
        const canvas = document.getElementById(chartId);
        if (!canvas) {
            console.error('[Visualization] Canvas not found:', chartId);
            return;
        }
        
        if (!this.processedData || !this.processedData.records) {
            console.error('[Visualization] No processed data available');
            showToast('No data available to render', 'error');
            return;
        }
        
        // Filter records using current filter settings
        let records = this.filterRecords(this.processedData.records);
        
        // Extract data for the column
        const filteredRecords = records.filter(r => r[column] !== null && r[column] !== undefined);
        
        if (filteredRecords.length === 0) {
            showToast(`No data found for ${this.formatColumnName(column)}`, 'warning');
            return;
        }
        
        // Downsample if too many points (for performance)
        const maxPoints = 2000;
        let sampledRecords = filteredRecords;
        if (filteredRecords.length > maxPoints) {
            const step = Math.ceil(filteredRecords.length / maxPoints);
            sampledRecords = filteredRecords.filter((_, i) => i % step === 0);
        }
        
        // Create labels and data arrays
        const labels = sampledRecords.map(r => r.timestamp);
        const dataValues = sampledRecords.map(r => r[column]);
        
        // Calculate stats from full dataset
        const allValues = filteredRecords.map(r => r[column]);
        const stats = {
            count: allValues.length,
            min: Math.min(...allValues).toFixed(3),
            max: Math.max(...allValues).toFixed(3),
            avg: (allValues.reduce((a, b) => a + b, 0) / allValues.length).toFixed(3)
        };
        
        // Update stats display
        const statsEl = document.getElementById(`${chartId}-stats`);
        if (statsEl) {
            statsEl.innerHTML = `
                <span class="viz-graph-stat">Points: <strong>${stats.count.toLocaleString()}</strong></span>
                <span class="viz-graph-stat">Min: <strong>${stats.min}</strong></span>
                <span class="viz-graph-stat">Max: <strong>${stats.max}</strong></span>
                <span class="viz-graph-stat">Avg: <strong>${stats.avg}</strong></span>
            `;
        }
        
        // Update time range
        const timeEl = document.getElementById(`${chartId}-time`);
        if (timeEl && labels.length > 0) {
            timeEl.textContent = `${labels[0]} → ${labels[labels.length - 1]}`;
        }
        
        // Destroy existing chart if any
        if (this.charts.has(chartId)) {
            this.charts.get(chartId).destroy();
        }
        
        // Determine chart color based on column type
        let borderColor = '#3B82F6';
        let backgroundColor = 'rgba(59, 130, 246, 0.1)';
        
        if (column.includes('DDM')) {
            borderColor = '#8B5CF6';
            backgroundColor = 'rgba(139, 92, 246, 0.1)';
        } else if (column.includes('SDM')) {
            borderColor = '#10B981';
            backgroundColor = 'rgba(16, 185, 129, 0.1)';
        } else if (column.includes('RF')) {
            borderColor = '#F59E0B';
            backgroundColor = 'rgba(245, 158, 11, 0.1)';
        } else if (column.includes('FREQ')) {
            borderColor = '#EC4899';
            backgroundColor = 'rgba(236, 72, 153, 0.1)';
        }
        
        // Create chart with simple labels (no time adapter needed)
        const ctx = canvas.getContext('2d');
        const chart = new Chart(ctx, {
            type: chartType === 'scatter' ? 'scatter' : 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: this.formatColumnName(column),
                    data: dataValues,
                    borderColor: borderColor,
                    backgroundColor: chartType === 'scatter' ? borderColor : backgroundColor,
                    borderWidth: chartType === 'scatter' ? 0 : 1.5,
                    pointRadius: chartType === 'scatter' ? 2 : 0,
                    pointHoverRadius: 4,
                    fill: chartType !== 'scatter',
                    tension: 0.1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    intersect: false,
                    mode: 'index'
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            title: (items) => {
                                if (items[0]) {
                                    return labels[items[0].dataIndex] || '';
                                }
                                return '';
                            },
                            label: (item) => {
                                return `${this.formatColumnName(column)}: ${item.raw.toFixed(3)}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        display: true,
                        grid: {
                            display: false
                        },
                        ticks: {
                            maxRotation: 0,
                            maxTicksLimit: 8,
                            font: { size: 10 },
                            callback: function(value, index) {
                                // Show abbreviated timestamp
                                const label = this.getLabelForValue(value);
                                if (typeof label === 'string' && label.length > 10) {
                                    // Extract just time portion HH:MM:SS
                                    const timePart = label.split(' ')[1];
                                    return timePart ? timePart.substring(0, 8) : label.substring(0, 10);
                                }
                                return label;
                            }
                        }
                    },
                    y: {
                        display: true,
                        grid: {
                            color: 'rgba(0, 0, 0, 0.05)'
                        },
                        ticks: {
                            font: { size: 10 }
                        }
                    }
                }
            }
        });
        
        this.charts.set(chartId, chart);
        console.log(`[Visualization] Chart rendered: ${chartId} with ${dataValues.length} points`);
    },
    
    /**
     * Toggle chart type between line and scatter
     */
    toggleChartType(chartId) {
        const card = document.getElementById(`${chartId}-card`);
        if (!card) return;
        
        const currentType = card.dataset.chartType;
        const newType = currentType === 'line' ? 'scatter' : 'line';
        card.dataset.chartType = newType;
        
        this.renderChart(chartId, card.dataset.column, card.dataset.equipment, newType);
    },
    
    /**
     * Remove a graph
     */
    removeGraph(chartId) {
        // Destroy chart instance
        if (this.charts.has(chartId)) {
            this.charts.get(chartId).destroy();
            this.charts.delete(chartId);
        }
        
        // Remove card element
        const card = document.getElementById(`${chartId}-card`);
        if (card) {
            card.remove();
        }
        
        // Show empty state if no charts remain
        if (this.charts.size === 0) {
            const emptyState = document.getElementById('vizEmptyState');
            if (emptyState) emptyState.style.display = 'flex';
        }
    },
    
    /**
     * Refresh all charts with new data
     */
    refreshAllCharts() {
        this.charts.forEach((chart, chartId) => {
            const card = document.getElementById(`${chartId}-card`);
            if (card) {
                this.renderChart(
                    chartId,
                    card.dataset.column,
                    card.dataset.equipment,
                    card.dataset.chartType
                );
            }
        });
    }
};

/**
 * Quick add graph function
 */
function quickAddGraph(column) {
    if (!VisualizationManager.processedData) {
        showToast('No data loaded yet', 'warning');
        return;
    }
    VisualizationManager.addGraph(column);
}

// Make visualization functions globally accessible
window.quickAddGraph = quickAddGraph;
window.VisualizationManager = VisualizationManager;

// Initialize visualization when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    VisualizationManager.init();
});

// ============================================
// UPDATE FileWatcherClient to handle processed data
// ============================================
// Extend the existing handleMessage to process visualization data
const originalHandleMessage = FileWatcherClient.handleMessage;
FileWatcherClient.handleMessage = function(data) {
    // Call original handler first
    if (originalHandleMessage) {
        originalHandleMessage.call(this, data);
    }
    
    // Handle processed data updates
    if (data.type === 'processed-data' || data.type === 'processed-data-updated') {
        console.log('[FileWatcher] Received processed data update');
        VisualizationManager.handleProcessedData(data.data);
        
        if (data.type === 'processed-data-updated') {
            VisualizationManager.refreshAllCharts();
            showToast('Data updated - charts refreshed', 'info');
        }
    }
};