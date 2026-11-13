/**
 * ============================================================================
 * 🍃 KRATOM POS + LINE OA BOT — Code.gs v16.0.2 COMMERCIAL
 * ============================================================================
 * Complete Backend: POS API + Google Sheets Sync + LINE Bot Analytics
 * 
 * ✨ v16.0.2 NEW:
 *   ✅ StockBalance Sheet (auto-deduct + fast read + audit trail)
 *   ✅ Line Quota Optimization (reply-only + aggregation)
 *   ✅ Smart Summary Command (1 command = all-in-one report)
 *   ✅ Quota Guard (anti-spam + push limit)
 *   ✅ Stock Check before sale (ป้องกันติดลบ)
 *   ✅ StockHistory audit trail
 *   ✅ RebuildStockBalance (กู้คืน)
 * 
 * 📋 SETUP:
 * 1. สร้าง Google Sheet → Extensions → Apps Script
 * 2. วางโค้ดนี้ (ทั้ง 3 Parts รวมกันใน Code.gs)
 * 3. Run > installSystem (ครั้งแรกเท่านั้น)
 * 4. Deploy > New deployment > Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. ตั้งค่า Webhook URL ใน LINE Developers Console
 * ============================================================================
 */

// ============================================================================
// ⚙️ CORE CONFIGURATION (v16.0.2)
// ============================================================================
const CONFIG = {
  VERSION: '16.0.2-COMMERCIAL',
  SHEET_NAMES: {
    LOGS: 'Logs',
    EXPENSES: 'Expenses',
    PRODUCTS: 'Products',
    CONFIG: 'Config',
    USERS: 'Users',
    AUDIT: 'AuditLog',
    SESSIONS: 'Sessions',
    DAILY_STATS: 'DailyStats',
    STOCK_BALANCE: 'StockBalance',
    STOCK_HISTORY: 'StockHistory'
  },
  CACHE_TTL: 30,
  LOCK_TIMEOUT: 30000,
  MAX_RETRY: 3,
  RETRY_DELAY: 500,
  CACHE_KEYS: {
    ALL_DATA: 'kratom_all_data_v162',
    CONFIG: 'kratom_config_v162',
    PRODUCTS: 'kratom_products_v162',
    STOCK: 'kratom_stock_v162'
  },
  API_KEY: '',
  REQUIRE_API_KEY: false,
  RATE_LIMIT_PER_MINUTE: 300,
  
  // LINE QUOTA OPTIMIZATION
  QUOTA: {
    USE_REPLY_ONLY: true,
    MIN_REPLY_INTERVAL_MS: 3000,
    DAILY_REPORT_ENABLED: true,
    WEEKLY_REPORT_ENABLED: false,
    MONTHLY_REPORT_ENABLED: true,
    STOCK_ALERT_ENABLED: true,
    STOCK_ALERT_ONCE_PER_DAY: true,
    AGGREGATE_HINT: true,
    MAX_PUSH_PER_USER_PER_DAY: 5
  }
};

// ============================================================================
// 🔐 SECRETS HELPER — PropertiesService
// ============================================================================
function _getSecret(key, fallback) {
  try {
    const v = PropertiesService.getScriptProperties().getProperty(key);
    return v || fallback;
  } catch (e) { return fallback; }
}

function setSecret(key, value) {
  try {
    PropertiesService.getScriptProperties().setProperty(key, value);
    return { status: 'success', key: key };
  } catch (e) { return { status: 'error', message: e.toString() }; }
}

// ============================================================================
// ⚙️ LINE OA CONFIGURATION
// ============================================================================
const LINE_CONFIG = {
  get CHANNEL_ACCESS_TOKEN() {
    return _getSecret('LINE_CHANNEL_ACCESS_TOKEN',
      'CgWxjOuCug7oxH2ePRxwk/Diajfn2XhPzGaZf62MpnjPKx2id3pYS+nemsJ9CJVT2QIR+eNLFHZ8QSDCFn3iK8OS8vWGgp9sRpk7hB7UCVzfKIQZKKul4Z+t6FXtIXql/0NptqvMNHiniDLQGOIyJQdB04t89/1O/w1cDnyilFU=');
  },
  get CHANNEL_SECRET() {
    return _getSecret('LINE_CHANNEL_SECRET', '01ff47cc69a651beb593b92dc9f5a8a4');
  },
  get ADMIN_USER_ID() {
    return _getSecret('LINE_ADMIN_USER_ID', 'Ue3897727f45a57d2ae308be17f17c215');
  },
  API_ENDPOINT: 'https://api.line.me/v2/bot',
  DATA_ENDPOINT: 'https://api-data.line.me/v2/bot',
  RICHMENU_ENABLED: true,
  PUSH_ENABLED: true,
  DAILY_REPORT_HOUR: 21,
  WEEKLY_REPORT_DAY: 'SUNDAY',
  WEEKLY_REPORT_HOUR: 21,
  MONTHLY_REPORT_DAY: 1,
  MONTHLY_REPORT_HOUR: 9,
  CACHE_TTL: 60
};

// ============================================================================
// 🛒 SALE COMMAND ALIASES
// ============================================================================
const SALE_ALIASES = {
  RED: ['ฝาแดง', 'แดง', 'a'],
  BM: ['บีเอ็ม', 'บี', 'bm', 'b'],
  ORIGINAL: ['น้ำดิบ', 'น้ำ', 'ดิบ', 't']
};

// ============================================================================
// 📌 MAIN ROUTER
// ============================================================================
function doGet(e) {
  return handleRequest(e, 'GET');
}

function doPost(e) {
  try {
    if (e.postData && e.postData.contents) {
      const data = JSON.parse(e.postData.contents);
      if (data.events && Array.isArray(data.events)) {
        return handleLineWebhook(e, data);
      }
      if (data.action) {
        return handleRequest(e, 'POST');
      }
    }
    return jsonResponse({ status: 'error', message: 'Unknown request type' }, 400);
  } catch (err) {
    console.error('doPost error:', err);
    return jsonResponse({ status: 'error', message: err.toString() }, 500);
  }
}

// ============================================================================
// 📌 POS API REQUEST HANDLER
// ============================================================================
function handleRequest(e, method) {
  const startTime = new Date().getTime();
  const requestId = Utilities.getUuid();
  try {
    if (CONFIG.REQUIRE_API_KEY) {
      const clientKey = (e.parameter && e.parameter.key) || '';
      if (clientKey !== CONFIG.API_KEY) {
        return jsonResponse({ status: 'error', message: 'Unauthorized: Invalid API Key', requestId: requestId }, 401);
      }
    }
    let action = '';
    let payload = {};
    if (method === 'GET') {
      action = (e.parameter && e.parameter.action) || 'GET_ALL';
      payload = e.parameter || {};
    } else {
      if (e.postData && e.postData.contents) {
        try {
          payload = JSON.parse(e.postData.contents);
          action = payload.action || '';
        } catch (parseErr) {
          return jsonResponse({ status: 'error', message: 'Invalid JSON payload: ' + parseErr.toString(), requestId: requestId }, 400);
        }
      } else {
        action = (e.parameter && e.parameter.action) || '';
        payload = e.parameter || {};
      }
    }
    try { logAudit({ requestId: requestId, action: action, method: method, ip: getClientIp(), userAgent: (e.parameter && e.parameter.ua) || 'unknown' }); }
    catch (auditErr) { console.warn('Audit log failed:', auditErr); }
    let result;
    switch (action) {
      case 'GET_ALL': result = getAllData(); break;
      case 'GET_LOGS': result = getLogs(payload); break;
      case 'GET_EXPENSES': result = getExpenses(payload); break;
      case 'GET_PRODUCTS': result = getProducts(); break;
      case 'GET_CONFIG': result = getConfig(); break;
      case 'GET_STATS': result = getStats(payload); break;
      case 'GET_STOCK': result = getStock(payload); break;
      case 'GET_STOCK_HISTORY': result = getStockHistory(payload); break;
      case 'REBUILD_STOCK': result = rebuildStockBalance(); break;
      case 'PING':
      case 'TEST_CONNECTION':
        result = { status: 'success', message: 'Kratom POS API v' + CONFIG.VERSION + ' is running', version: CONFIG.VERSION, timestamp: new Date().toISOString(), spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId() };
        break;
      case 'POS_SALE':
      case 'MANUAL_SALE':
      case 'ADD_STOCK':
      case 'LINE_SALE': result = addLog(payload); break;
      case 'ADD_EXPENSE': result = addExpense(payload); break;
      case 'SAVE_PRODUCT': result = saveProduct(payload); break;
      case 'SAVE_CONFIG': result = saveConfig(payload); break;
      case 'SAVE_BATCH': result = saveBatch(payload); break;
      case 'DELETE':
      case 'DELETE_LOG': result = deleteLog(payload); break;
      case 'DELETE_EXPENSE': result = deleteExpense(payload); break;
      case 'DELETE_PRODUCT': result = deleteProduct(payload); break;
      case 'BACKUP': result = createBackup(); break;
      case 'SETUP': result = setupSpreadsheet(); break;
      case 'HEALTH_CHECK': result = healthCheck(); break;
      default: return jsonResponse({ status: 'error', message: 'Unknown action: ' + action, requestId: requestId }, 400);
    }
    const elapsed = new Date().getTime() - startTime;
    result.requestId = requestId;
    result.elapsedMs = elapsed;
    result.serverTime = new Date().toISOString();
    return jsonResponse(result, 200);
  } catch (err) {
    console.error('handleRequest error:', err);
    return jsonResponse({ status: 'error', message: err.toString(), stack: err.stack, requestId: requestId }, 500);
  }
}

function jsonResponse(data, statusCode) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================================
// 📌 SHEET SETUP
// ============================================================================
function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const created = [];
  const existing = [];
  const logsHeaders = ['id', 'timestamp', 'type', 'qty', 'unitPrice', 'total', 'source', 'paymentMethod', 'recipeType', 'productName', 'action', 'note', 'createdAt', 'createdBy'];
  ensureSheet(ss, CONFIG.SHEET_NAMES.LOGS, logsHeaders, created, existing);
  const expensesHeaders = ['id', 'timestamp', 'category', 'amount', 'paymentMethod', 'description', 'createdAt', 'createdBy'];
  ensureSheet(ss, CONFIG.SHEET_NAMES.EXPENSES, expensesHeaders, created, existing);
  const productsHeaders = ['id', 'name', 'recipeType', 'price', 'status', 'createdAt', 'updatedAt'];
  ensureSheet(ss, CONFIG.SHEET_NAMES.PRODUCTS, productsHeaders, created, existing);
  const configHeaders = ['key', 'value', 'updatedAt'];
  ensureSheet(ss, CONFIG.SHEET_NAMES.CONFIG, configHeaders, created, existing);
  const usersHeaders = ['id', 'username', 'role', 'pin', 'active', 'createdAt'];
  ensureSheet(ss, CONFIG.SHEET_NAMES.USERS, usersHeaders, created, existing);
  const auditHeaders = ['requestId', 'action', 'method', 'ip', 'userAgent', 'timestamp'];
  ensureSheet(ss, CONFIG.SHEET_NAMES.AUDIT, auditHeaders, created, existing);
  const sessionsHeaders = ['sessionId', 'userId', 'startedAt', 'lastSeen', 'active'];
  ensureSheet(ss, CONFIG.SHEET_NAMES.SESSIONS, sessionsHeaders, created, existing);
  const statsHeaders = ['date', 'revenue', 'expenses', 'profit', 'volume', 'cashRevenue', 'transferRevenue', 'txCount', 'updatedAt'];
  ensureSheet(ss, CONFIG.SHEET_NAMES.DAILY_STATS, statsHeaders, created, existing);
  const stockHeaders = ['productId', 'productName', 'recipeType', 'balance', 'inTotal', 'outTotal', 'lastUpdated', 'lastUpdatedBy'];
  ensureSheet(ss, CONFIG.SHEET_NAMES.STOCK_BALANCE, stockHeaders, created, existing);
  const stockHistHeaders = ['timestamp', 'productName', 'type', 'qty', 'oldBalance', 'newBalance', 'delta', 'source', 'createdBy'];
  ensureSheet(ss, CONFIG.SHEET_NAMES.STOCK_HISTORY, stockHistHeaders, created, existing);
  seedDefaultData(ss);
  seedStockBalance(ss);
  formatSheets(ss);
  logAudit({ requestId: 'SETUP_' + Utilities.getUuid(), action: 'SETUP', method: 'SYSTEM', ip: 'internal', userAgent: 'setupSpreadsheet' });
  return { status: 'success', message: 'Spreadsheet setup complete', created: created, existing: existing, spreadsheetId: ss.getId(), spreadsheetUrl: ss.getUrl(), version: CONFIG.VERSION };
}

function ensureSheet(ss, sheetName, headers, createdList, existingList) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#10b981').setFontColor('#ffffff').setHorizontalAlignment('center');
    sheet.setFrozenRows(1);
    sheet.setColumnWidths(1, headers.length, 140);
    createdList.push(sheetName);
  } else {
    const existingHeaders = sheet.getRange(1, 1, 1, Math.max(headers.length, sheet.getLastColumn() || 1)).getValues()[0];
    let needsHeaderFix = false;
    for (let i = 0; i < headers.length; i++) {
      if (existingHeaders[i] !== headers[i]) { needsHeaderFix = true; break; }
    }
    if (needsHeaderFix) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#10b981').setFontColor('#ffffff');
    }
    existingList.push(sheetName);
  }
  return sheet;
}

function seedDefaultData(ss) {
  const productsSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.PRODUCTS);
  if (productsSheet.getLastRow() <= 1) {
    const now = new Date().toISOString();
    const defaults = [
      ['P1', 'น้ำกระท่อมสูตรฝาแดง (1000ml)', 'RED', 35, 'ACTIVE', now, now],
      ['P2', 'น้ำกระท่อมสูตร BM (1000ml)', 'BM', 35, 'ACTIVE', now, now],
      ['P3', 'น้ำดิบ Original (1000ml)', 'ORIGINAL', 25, 'ACTIVE', now, now]
    ];
    productsSheet.getRange(2, 1, defaults.length, defaults[0].length).setValues(defaults);
  }
  const configSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.CONFIG);
  if (configSheet.getLastRow() <= 1) {
    const now = new Date().toISOString();
    const defaultRedIngredients = [
      {id:'red_coke',name:'โค้กฝาแดง',unit:'L',enabled:true,qty:7,price:26,pricePer:1,color:'#ef4444'},
      {id:'red_med',name:'ยาแก้ไอฝาแดง',unit:'ml',enabled:true,qty:140,price:54,pricePer:60,color:'#f472b6'},
      {id:'red_plum88',name:'ผงบ๊วย 88',unit:'ml',enabled:true,qty:75,price:1,pricePer:1,color:'#fbbf24'},
      {id:'red_sweet',name:'ผงหวาน',unit:'g',enabled:true,qty:5,price:1,pricePer:1,color:'#a3e635'}
    ];
    const defaultBmIngredients = [
      {id:'bm_coke',name:'โค้ก BM',unit:'L',enabled:true,qty:7,price:26,pricePer:1,color:'#ef4444'},
      {id:'bm_plum',name:'บ๊วย (เม็ด)',unit:'เม็ด',enabled:true,qty:63,price:1,pricePer:1,color:'#a78bfa'},
      {id:'bm_med',name:'ยาแก้ไอ BM',unit:'ml',enabled:true,qty:140,price:34,pricePer:60,color:'#f472b6'},
      {id:'bm_plum88',name:'ผงบ๊วย 88',unit:'ml',enabled:true,qty:75,price:1,pricePer:1,color:'#fbbf24'},
      {id:'bm_sweet',name:'ผงหวาน',unit:'g',enabled:true,qty:5,price:1,pricePer:1,color:'#a3e635'},
      {id:'bm_salted',name:'ผงบ๊วยเค็ม',unit:'ml',enabled:true,qty:20,price:1,pricePer:1,color:'#fb923c'}
    ];
    const defaults = [
      ['costLeaves', 100, now], ['costBottle', 5, now], ['costHidden', 4, now],
      ['costCokeRed', 26, now], ['costSyrupRed', 54, now], ['sellPriceRed', 35, now],
      ['costCokeBm', 26, now], ['costSyrupBm', 34, now], ['costPlumBm', 1, now], ['sellPriceBm', 35, now],
      ['ratio', 25, now], ['extractPercent', 80, now], ['mixBaseWater', 21, now],
      ['mixBottlePerLiter', 1, now], ['mixYieldPercent', 90, now],
      ['redIngredients', JSON.stringify(defaultRedIngredients), now],
      ['bmIngredients', JSON.stringify(defaultBmIngredients), now],
      ['brewUtilityCostPerLiter', 2, now], ['brewLaborCostPerKg', 20, now], ['brewYieldPerKg', 0.04, now],
      ['kpiTargetRevenue', 50000, now], ['kpiTargetVolume', 1500, now], ['kpiTargetProfit', 15000, now],
      ['shopName', 'ท่อมกันเอง ส.สามสี', now], ['shopAddress', '', now], ['shopPhone', '', now]
    ];
    configSheet.getRange(2, 1, defaults.length, defaults[0].length).setValues(defaults);
  }
}

function formatSheets(ss) {
  const sheetsToFormat = [
    CONFIG.SHEET_NAMES.LOGS, CONFIG.SHEET_NAMES.EXPENSES, CONFIG.SHEET_NAMES.PRODUCTS,
    CONFIG.SHEET_NAMES.CONFIG, CONFIG.SHEET_NAMES.AUDIT, CONFIG.SHEET_NAMES.DAILY_STATS,
    CONFIG.SHEET_NAMES.STOCK_BALANCE, CONFIG.SHEET_NAMES.STOCK_HISTORY
  ];
  sheetsToFormat.forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (sheet) {
      try { sheet.getRange(1, 1, Math.max(sheet.getMaxRows(), 2), sheet.getMaxColumns()).setFontFamily('Kanit').setFontSize(10); } catch (e) {}
    }
  });
}

// ============================================================================
// 📌 READ OPERATIONS
// ============================================================================
function getAllData() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CONFIG.CACHE_KEYS.ALL_DATA);
  if (cached) { try { return JSON.parse(cached); } catch (e) { cache.remove(CONFIG.CACHE_KEYS.ALL_DATA); } }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logs = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.LOGS);
  const expenses = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.EXPENSES);
  const products = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.PRODUCTS);
  const config = readConfigAsObject(ss);
  const result = {
    status: 'success',
    logs: logs,
    expenses: expenses,
    products: products,
    config: config,
    counts: { logs: logs.length, expenses: expenses.length, products: products.length, config: Object.keys(config).length }
  };
  try { cache.put(CONFIG.CACHE_KEYS.ALL_DATA, JSON.stringify(result), CONFIG.CACHE_TTL); } catch (e) {}
  return result;
}

function getLogs(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let logs = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.LOGS);
  if (payload && payload.fromDate) { const from = new Date(payload.fromDate).getTime(); logs = logs.filter(l => new Date(l.timestamp).getTime() >= from); }
  if (payload && payload.toDate) { const to = new Date(payload.toDate).getTime() + 86400000; logs = logs.filter(l => new Date(l.timestamp).getTime() <= to); }
  if (payload && payload.type) logs = logs.filter(l => l.type === payload.type);
  if (payload && payload.limit) logs = logs.slice(0, Number(payload.limit));
  return { status: 'success', logs: logs, count: logs.length };
}

function getExpenses(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let expenses = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.EXPENSES);
  if (payload && payload.fromDate) { const from = new Date(payload.fromDate).getTime(); expenses = expenses.filter(e => new Date(e.timestamp).getTime() >= from); }
  if (payload && payload.toDate) { const to = new Date(payload.toDate).getTime() + 86400000; expenses = expenses.filter(e => new Date(e.timestamp).getTime() <= to); }
  if (payload && payload.limit) expenses = expenses.slice(0, Number(payload.limit));
  return { status: 'success', expenses: expenses, count: expenses.length };
}

function getProducts() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const products = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.PRODUCTS);
  return { status: 'success', products: products, count: products.length };
}

function getConfig() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const config = readConfigAsObject(ss);
  return { status: 'success', config: config };
}

function getStats(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let stats = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.DAILY_STATS);
  if (payload && payload.limit) stats = stats.slice(-Number(payload.limit));
  return { status: 'success', stats: stats, count: stats.length };
}

// ============================================================================
// 📦 STOCK BALANCE API
// ============================================================================
function getStock(payload) {
  try {
    const balance = readStockBalance(payload && payload.productId);
    return { status: 'success', stock: balance, timestamp: new Date().toISOString() };
  } catch (e) {
    return { status: 'error', message: e.toString() };
  }
}

function getStockHistory(payload) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STOCK_HISTORY);
    if (!sheet) return { status: 'success', history: [], count: 0 };
    const limit = Number(payload && payload.limit) || 100;
    const data = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.STOCK_HISTORY);
    const filtered = payload && payload.productName
      ? data.filter(r => r.productName === payload.productName)
      : data;
    return { status: 'success', history: filtered.slice(-limit).reverse(), count: filtered.length };
  } catch (e) {
    return { status: 'error', message: e.toString() };
  }
}

// ============================================================================
// 📌 WRITE OPERATIONS — with Auto Stock Deduct (v16.0.2)
// ============================================================================
function addLog(payload) {
  return withLock(function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.LOGS);
    const record = {
      id: payload.id || ('TX_' + new Date().getTime() + '_' + Utilities.getUuid().slice(0, 4)),
      timestamp: payload.timestamp || new Date().toISOString(),
      type: payload.type || 'OUT',
      qty: Number(payload.qty) || 0,
      unitPrice: Number(payload.unitPrice) || 0,
      total: Number(payload.total) || 0,
      source: payload.source || 'POS',
      paymentMethod: payload.paymentMethod || 'CASH',
      recipeType: payload.recipeType || '',
      productName: payload.productName || '',
      action: payload.action || 'POS_SALE',
      note: payload.note || '',
      createdAt: new Date().toISOString(),
      createdBy: payload.createdBy || 'system'
    };
    const headers = getHeaders(sheet);
    const row = headers.map(h => record[h] !== undefined ? record[h] : '');
    sheet.appendRow(row);
    
    // 🆕 AUTO STOCK DEDUCT
    let stockUpdate = null;
    try {
      stockUpdate = updateStockBalance(
        record.productName,
        record.type,
        record.qty,
        record.createdBy
      );
      record.stockBalance = stockUpdate.newBalance;
    } catch (e) {
      console.error('[addLog] Stock update failed:', e);
      record.stockError = e.toString();
    }
    
    invalidateCache();
    updateDailyStats(record.timestamp);
    return {
      status: 'success',
      message: 'Log added',
      id: record.id,
      record: record,
      stockUpdate: stockUpdate
    };
  });
}

function addExpense(payload) {
  return withLock(function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.EXPENSES);
    const record = {
      id: payload.id || ('EXP_' + new Date().getTime() + '_' + Utilities.getUuid().slice(0, 4)),
      timestamp: payload.timestamp || new Date().toISOString(),
      category: payload.category || 'OTHER',
      amount: Number(payload.amount) || 0,
      paymentMethod: payload.paymentMethod || 'CASH',
      description: payload.description || '',
      createdAt: new Date().toISOString(),
      createdBy: payload.createdBy || 'system'
    };
    const headers = getHeaders(sheet);
    const row = headers.map(h => record[h] !== undefined ? record[h] : '');
    sheet.appendRow(row);
    invalidateCache();
    updateDailyStats(record.timestamp);
    return { status: 'success', message: 'Expense added', id: record.id, record: record };
  });
}

function saveProduct(payload) {
  return withLock(function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.PRODUCTS);
    const record = {
      id: payload.id || ('P_' + new Date().getTime()),
      name: payload.name || '',
      recipeType: payload.recipeType || 'RED',
      price: Number(payload.price) || 35,
      status: payload.status || 'ACTIVE',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (!record.name) return { status: 'error', message: 'Product name is required' };
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf('id');
    let existingRowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) === String(record.id)) { existingRowIndex = i + 1; break; }
    }
    if (existingRowIndex > 0) {
      record.createdAt = data[existingRowIndex - 1][headers.indexOf('createdAt')] || record.createdAt;
      const row = headers.map(h => record[h] !== undefined ? record[h] : '');
      sheet.getRange(existingRowIndex, 1, 1, row.length).setValues([row]);
    } else {
      const row = headers.map(h => record[h] !== undefined ? record[h] : '');
      sheet.appendRow(row);
    }
    invalidateCache();
    // Sync ไป StockBalance
    try {
      const stockSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STOCK_BALANCE);
      if (stockSheet) {
        const stockData = stockSheet.getDataRange().getValues();
        const stockHeaders = stockData[0];
        const stockNameCol = stockHeaders.indexOf('productName');
        let found = false;
        for (let i = 1; i < stockData.length; i++) {
          if (String(stockData[i][stockNameCol]) === String(record.name)) {
            found = true;
            break;
          }
        }
        if (!found) {
          stockSheet.appendRow([record.id, record.name, record.recipeType, 0, 0, 0, new Date().toISOString(), 'save_product']);
        }
      }
    } catch (e) { console.warn('Stock sync on saveProduct failed:', e); }
    return { status: 'success', message: existingRowIndex > 0 ? 'Product updated' : 'Product created', id: record.id, record: record };
  });
}

function saveConfig(payload) {
  return withLock(function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.CONFIG);
    const configData = payload.config || payload;
    const now = new Date().toISOString();
    const data = sheet.getDataRange().getValues();
    const existingKeys = {};
    for (let i = 1; i < data.length; i++) existingKeys[String(data[i][0])] = i + 1;
    let updated = 0, added = 0;
    for (const key in configData) {
      if (key === 'action' || key === 'products') continue;
      let value = configData[key];
      if (value !== null && typeof value === 'object') {
        try { value = JSON.stringify(value); } catch (e) { continue; }
      }
      if (existingKeys[key]) {
        sheet.getRange(existingKeys[key], 2, 1, 2).setValues([[value, now]]);
        updated++;
      } else {
        sheet.appendRow([key, value, now]);
        added++;
      }
    }
    invalidateCache();
    return { status: 'success', message: 'Config saved', updated: updated, added: added };
  });
}

function saveBatch(payload) {
  return withLock(function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const results = { logs: 0, expenses: 0, products: 0, errors: [] };
    if (payload.logs && Array.isArray(payload.logs)) {
      const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.LOGS);
      const headers = getHeaders(sheet);
      const rows = payload.logs.map(log => {
        const record = {
          id: log.id || ('TX_' + new Date().getTime() + '_' + Utilities.getUuid().slice(0, 4)),
          timestamp: log.timestamp || new Date().toISOString(),
          type: log.type || 'OUT', qty: Number(log.qty) || 0, unitPrice: Number(log.unitPrice) || 0, total: Number(log.total) || 0,
          source: log.source || 'BATCH', paymentMethod: log.paymentMethod || 'CASH', recipeType: log.recipeType || '',
          productName: log.productName || '', action: log.action || 'BATCH', note: log.note || '',
          createdAt: new Date().toISOString(), createdBy: log.createdBy || 'batch'
        };
        return headers.map(h => record[h] !== undefined ? record[h] : '');
      });
      if (rows.length > 0) {
        sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
        results.logs = rows.length;
        // Update stock for each log
        payload.logs.forEach(log => {
          try {
            updateStockBalance(log.productName, log.type || 'OUT', log.qty, log.createdBy || 'batch');
          } catch (e) { console.warn('Batch stock update failed:', e); }
        });
      }
    }
    if (payload.expenses && Array.isArray(payload.expenses)) {
      const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.EXPENSES);
      const headers = getHeaders(sheet);
      const rows = payload.expenses.map(exp => {
        const record = {
          id: exp.id || ('EXP_' + new Date().getTime() + '_' + Utilities.getUuid().slice(0, 4)),
          timestamp: exp.timestamp || new Date().toISOString(), category: exp.category || 'OTHER',
          amount: Number(exp.amount) || 0, paymentMethod: exp.paymentMethod || 'CASH',
          description: exp.description || '', createdAt: new Date().toISOString(), createdBy: exp.createdBy || 'batch'
        };
        return headers.map(h => record[h] !== undefined ? record[h] : '');
      });
      if (rows.length > 0) {
        sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
        results.expenses = rows.length;
      }
    }
    invalidateCache();
    return { status: 'success', message: 'Batch save complete', results: results };
  });
}

// ============================================================================
// 📌 DELETE OPERATIONS — with Stock Reverse (v16.0.2)
// ============================================================================
function deleteLog(payload) {
  return withLock(function() {
    if (!payload.id) return { status: 'error', message: 'id is required' };
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.LOGS);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf('id');
    const nameCol = headers.indexOf('productName');
    const typeCol = headers.indexOf('type');
    const qtyCol = headers.indexOf('qty');
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) === String(payload.id)) {
        const productName = data[i][nameCol];
        const type = data[i][typeCol];
        const qty = Number(data[i][qtyCol]) || 0;
        // 🆕 คืน stock ก่อนลบ
        try {
          const reverseType = type === 'IN' ? 'OUT' : 'IN';
          updateStockBalance(productName, reverseType, qty, 'system_delete');
        } catch (e) {
          console.warn('[deleteLog] Stock reverse failed:', e);
        }
        sheet.deleteRow(i + 1);
        invalidateCache();
        return { status: 'success', message: 'Log deleted + stock reversed', id: payload.id };
      }
    }
    return { status: 'error', message: 'Log not found: ' + payload.id };
  });
}

function deleteExpense(payload) { return withLock(function() { return deleteRowById(CONFIG.SHEET_NAMES.EXPENSES, payload.id, 'Expense'); }); }

function deleteProduct(payload) {
  return withLock(function() {
    const result = deleteRowById(CONFIG.SHEET_NAMES.PRODUCTS, payload.id, 'Product');
    // ลบ StockBalance ด้วย
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const stockSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STOCK_BALANCE);
      if (stockSheet && payload.id) {
        const data = stockSheet.getDataRange().getValues();
        const headers = data[0];
        const idCol = headers.indexOf('productId');
        for (let i = 1; i < data.length; i++) {
          if (String(data[i][idCol]) === String(payload.id)) {
            stockSheet.deleteRow(i + 1);
            break;
          }
        }
      }
    } catch (e) { console.warn('Stock delete on deleteProduct failed:', e); }
    return result;
  });
}

function deleteRowById(sheetName, id, label) {
  if (!id) return { status: 'error', message: 'id is required' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('id');
  if (idCol < 0) return { status: 'error', message: 'id column not found' };
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(id)) {
      sheet.deleteRow(i + 1);
      invalidateCache();
      return { status: 'success', message: label + ' deleted', id: id };
    }
  }
  return { status: 'error', message: label + ' not found: ' + id };
}

// ============================================================================
// 📦 STOCK BALANCE SYSTEM (v16.0.2)
// ============================================================================

/**
 * Seed StockBalance sheet จาก Products + Logs
 */
function seedStockBalance(ss) {
  try {
    const stockSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STOCK_BALANCE);
    const productsSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.PRODUCTS);
    if (!stockSheet || !productsSheet) return;
    // ถ้ามีข้อมูลอยู่แล้ว ไม่ต้อง seed
    if (stockSheet.getLastRow() > 1) return;
    const products = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.PRODUCTS);
    if (products.length === 0) return;
    const logs = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.LOGS);
    const balanceMap = {};
    logs.forEach(l => {
      const name = l.productName;
      if (!name) return;
      if (!balanceMap[name]) balanceMap[name] = { balance: 0, inTotal: 0, outTotal: 0 };
      const qty = Number(l.qty) || 0;
      if (l.type === 'IN') {
        balanceMap[name].balance += qty;
        balanceMap[name].inTotal += qty;
      } else if (l.type === 'OUT') {
        balanceMap[name].balance -= qty;
        balanceMap[name].outTotal += qty;
      }
    });
    const now = new Date().toISOString();
    const rows = products.map(p => {
      const b = balanceMap[p.name] || { balance: 0, inTotal: 0, outTotal: 0 };
      return [
        p.id || 'P_' + Date.now(),
        p.name || '',
        p.recipeType || 'RED',
        b.balance,
        b.inTotal,
        b.outTotal,
        now,
        'seed'
      ];
    });
    stockSheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
    console.log('[StockBalance] Seeded ' + rows.length + ' products');
  } catch (e) {
    console.error('[seedStockBalance]', e);
  }
}

/**
 * อ่าน stock balance (cache 30 วิ)
 */
function readStockBalance(productIdOrName) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CONFIG.CACHE_KEYS.STOCK);
  let stockMap = null;
  if (cached) {
    try { stockMap = JSON.parse(cached); } catch (e) { cache.remove(CONFIG.CACHE_KEYS.STOCK); }
  }
  if (!stockMap) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STOCK_BALANCE);
    stockMap = {};
    if (sheet && sheet.getLastRow() > 1) {
      const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
      data.forEach(row => {
        const id = String(row[0] || '');
        const name = String(row[1] || '');
        const balance = Number(row[3]) || 0;
        if (id) stockMap[id] = balance;
        if (name) stockMap['name:' + name] = balance;
      });
    }
    try {
      cache.put(CONFIG.CACHE_KEYS.STOCK, JSON.stringify(stockMap), CONFIG.CACHE_TTL);
    } catch (e) {}
  }
  if (productIdOrName) {
    return stockMap[productIdOrName] !== undefined ? stockMap[productIdOrName] :
           stockMap['name:' + productIdOrName] !== undefined ? stockMap['name:' + productIdOrName] : 0;
  }
  return stockMap;
}

/**
 * อัปเดต stock balance (atomic)
 */
function updateStockBalance(productName, type, qty, createdBy) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STOCK_BALANCE);
  if (!sheet) {
    ensureSheet(ss, CONFIG.SHEET_NAMES.STOCK_BALANCE,
      ['productId', 'productName', 'recipeType', 'balance', 'inTotal', 'outTotal', 'lastUpdated', 'lastUpdatedBy'],
      [], []);
    sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STOCK_BALANCE);
  }
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const nameCol = headers.indexOf('productName');
  const balCol = headers.indexOf('balance');
  const inCol = headers.indexOf('inTotal');
  const outCol = headers.indexOf('outTotal');
  const tsCol = headers.indexOf('lastUpdated');
  const byCol = headers.indexOf('lastUpdatedBy');
  const delta = type === 'IN' ? Number(qty) : -Number(qty);
  const now = new Date().toISOString();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][nameCol]) === String(productName)) {
      const oldBalance = Number(data[i][balCol]) || 0;
      const newBalance = oldBalance + delta;
      sheet.getRange(i + 1, balCol + 1).setValue(newBalance);
      sheet.getRange(i + 1, tsCol + 1).setValue(now);
      sheet.getRange(i + 1, byCol + 1).setValue(createdBy || 'system');
      if (type === 'IN') {
        sheet.getRange(i + 1, inCol + 1).setValue((Number(data[i][inCol]) || 0) + Number(qty));
      } else {
        sheet.getRange(i + 1, outCol + 1).setValue((Number(data[i][outCol]) || 0) + Number(qty));
      }
      logStockHistory(productName, type, qty, oldBalance, newBalance, 'auto', createdBy);
      try { CacheService.getScriptCache().remove(CONFIG.CACHE_KEYS.STOCK); } catch (e) {}
      return { oldBalance: oldBalance, newBalance: newBalance, delta: delta };
    }
  }
  // ไม่มีใน sheet → เพิ่มใหม่
  const products = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.PRODUCTS);
  const product = products.find(p => p.name === productName);
  sheet.appendRow([
    product && product.id || 'SB_' + Date.now(),
    productName,
    product && product.recipeType || 'RED',
    delta,
    type === 'IN' ? Number(qty) : 0,
    type === 'OUT' ? Number(qty) : 0,
    now,
    createdBy || 'system'
  ]);
  logStockHistory(productName, type, qty, 0, delta, 'auto_new', createdBy);
  try { CacheService.getScriptCache().remove(CONFIG.CACHE_KEYS.STOCK); } catch (e) {}
  return { oldBalance: 0, newBalance: delta, delta: delta };
}

/**
 * บันทึก StockHistory (audit trail)
 */
function logStockHistory(productName, type, qty, oldBalance, newBalance, source, createdBy) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STOCK_HISTORY);
    if (!sheet) return;
    sheet.appendRow([
      new Date().toISOString(),
      productName,
      type,
      Number(qty),
      oldBalance,
      newBalance,
      newBalance - oldBalance,
      source || 'auto',
      createdBy || 'system'
    ]);
    const lastRow = sheet.getLastRow();
    if (lastRow > 10001) {
      sheet.deleteRows(2, 5000);
    }
  } catch (e) {
    console.warn('logStockHistory error:', e);
  }
}

/**
 * Rebuild StockBalance จาก Logs ทั้งหมด
 */
function rebuildStockBalance() {
  console.log('[rebuildStockBalance] Starting...');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const stockSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STOCK_BALANCE);
  if (!stockSheet) return { status: 'error', message: 'StockBalance sheet not found' };
  const logs = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.LOGS);
  const products = readSheetAsObjects(ss, CONFIG.SHEET_NAMES.PRODUCTS);
  const balanceMap = {};
  logs.forEach(l => {
    const name = l.productName;
    if (!name) return;
    if (!balanceMap[name]) balanceMap[name] = { balance: 0, inTotal: 0, outTotal: 0 };
    const qty = Number(l.qty) || 0;
    if (l.type === 'IN') {
      balanceMap[name].balance += qty;
      balanceMap[name].inTotal += qty;
    } else if (l.type === 'OUT') {
      balanceMap[name].balance -= qty;
      balanceMap[name].outTotal += qty;
    }
  });
  const data = stockSheet.getDataRange().getValues();
  const headers = data[0];
  const nameCol = headers.indexOf('productName');
  const now = new Date().toISOString();
  let updated = 0;
  for (let i = 1; i < data.length; i++) {
    const name = String(data[i][nameCol]);
    if (balanceMap[name]) {
      stockSheet.getRange(i + 1, 4, 1, 5).setValues([[
        balanceMap[name].balance,
        balanceMap[name].inTotal,
        balanceMap[name].outTotal,
        now,
        'rebuild'
      ]]);
      updated++;
    }
  }
  products.forEach(p => {
    const exists = data.some(row => String(row[nameCol]) === String(p.name));
    if (!exists) {
      const b = balanceMap[p.name] || { balance: 0, inTotal: 0, outTotal: 0 };
      stockSheet.appendRow([
        p.id || 'P_' + Date.now(),
        p.name,
        p.recipeType || 'RED',
        b.balance,
        b.inTotal,
        b.outTotal,
        now,
        'rebuild'
      ]);
      updated++;
    }
  });
  try { CacheService.getScriptCache().remove(CONFIG.CACHE_KEYS.STOCK); } catch (e) {}
  console.log('[rebuildStockBalance] Updated ' + updated + ' products');
  return { status: 'success', updated: updated, message: 'Stock rebuilt from logs' };
}

// ============================================================================
// 📌 STATISTICS — OPTIMIZED (v16.0.2)
// ============================================================================
function updateDailyStats(timestamp) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const statsSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.DAILY_STATS);
    const logsSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.LOGS);
    const expSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.EXPENSES);
    const date = new Date(timestamp);
    const tz = Session.getScriptTimeZone();
    const dateKey = Utilities.formatDate(date, tz, 'yyyy-MM-dd');

    function toKey(v) {
      if (!v) return '';
      try {
        const d = (v instanceof Date) ? v : new Date(v);
        if (isNaN(d.getTime())) return '';
        return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
      } catch (e) { return ''; }
    }

    const logsLastRow = logsSheet.getLastRow();
    let revenue = 0, volume = 0, cashRev = 0, transferRev = 0, txCount = 0;
    if (logsLastRow > 1) {
      const logsData = logsSheet.getRange(2, 1, logsLastRow - 1, logsSheet.getLastColumn()).getValues();
      const lh = logsSheet.getRange(1, 1, 1, logsSheet.getLastColumn()).getValues()[0];
      const tsCol = lh.indexOf('timestamp'), typeCol = lh.indexOf('type'), totalCol = lh.indexOf('total');
      const qtyCol = lh.indexOf('qty'), payCol = lh.indexOf('paymentMethod');
      for (let i = 0; i < logsData.length; i++) {
        if (toKey(logsData[i][tsCol]) !== dateKey) continue;
        if (logsData[i][typeCol] !== 'OUT') continue;
        const total = Number(logsData[i][totalCol]) || 0;
        revenue += total;
        volume += Number(logsData[i][qtyCol]) || 0;
        txCount++;
        const pm = logsData[i][payCol];
        if (pm === 'CASH') cashRev += total;
        else if (pm === 'TRANSFER') transferRev += total;
      }
    }

    let expenses = 0;
    const expLastRow = expSheet.getLastRow();
    if (expLastRow > 1) {
      const expData = expSheet.getRange(2, 1, expLastRow - 1, expSheet.getLastColumn()).getValues();
      const eh = expSheet.getRange(1, 1, 1, expSheet.getLastColumn()).getValues()[0];
      const eTsCol = eh.indexOf('timestamp'), eAmtCol = eh.indexOf('amount');
      for (let i = 0; i < expData.length; i++) {
        if (toKey(expData[i][eTsCol]) !== dateKey) continue;
        expenses += Number(expData[i][eAmtCol]) || 0;
      }
    }

    const profit = revenue - expenses;

    const statsLastRow = statsSheet.getLastRow();
    let existingRow = -1;
    if (statsLastRow > 1) {
      const statsData = statsSheet.getRange(2, 1, statsLastRow - 1, 1).getValues();
      for (let i = 0; i < statsData.length; i++) {
        if (String(statsData[i][0]) === dateKey) { existingRow = i + 2; break; }
      }
    }
    const rowData = [dateKey, revenue, expenses, profit, volume, cashRev, transferRev, txCount, new Date().toISOString()];
    if (existingRow > 0) statsSheet.getRange(existingRow, 1, 1, rowData.length).setValues([rowData]);
    else statsSheet.appendRow(rowData);
  } catch (err) { console.error('updateDailyStats error:', err); }
}

// ============================================================================
// 📌 UTILITY HELPERS
// ============================================================================
function readSheetAsObjects(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const results = [];
  for (let i = 0; i < data.length; i++) {
    const obj = {};
    let hasValue = false;
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j];
      let value = data[i][j];
      if (value instanceof Date) value = value.toISOString();
      obj[key] = value;
      if (value !== '' && value !== null && value !== undefined) hasValue = true;
    }
    if (hasValue) results.push(obj);
  }
  return results;
}

function readConfigAsObject(ss) {
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.CONFIG);
  if (!sheet) return {};
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return {};
  const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  const config = {};
  for (let i = 0; i < data.length; i++) {
    const key = data[i][0];
    let value = data[i][1];
    if (!key) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) { try { value = JSON.parse(trimmed); } catch (e) {} }
      else if (trimmed !== '' && !isNaN(trimmed)) { const num = Number(trimmed); if (!isNaN(num)) value = num; }
    }
    config[key] = value;
  }
  return config;
}

function getHeaders(sheet) { return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]; }

function withLock(fn) {
  const lock = LockService.getScriptLock();
  let locked = false;
  for (let attempt = 0; attempt < CONFIG.MAX_RETRY; attempt++) {
    try { locked = lock.tryLock(CONFIG.LOCK_TIMEOUT); if (locked) break; Utilities.sleep(CONFIG.RETRY_DELAY * (attempt + 1)); }
    catch (e) { console.warn('Lock attempt ' + (attempt + 1) + ' failed:', e); }
  }
  if (!locked) return { status: 'error', message: 'System busy - could not acquire lock' };
  try { return fn(); }
  catch (err) { console.error('withLock error:', err); return { status: 'error', message: err.toString() }; }
  finally { try { lock.releaseLock(); } catch (e) {} }
}

function invalidateCache() {
  try {
    const cache = CacheService.getScriptCache();
    cache.remove(CONFIG.CACHE_KEYS.ALL_DATA);
    cache.remove(CONFIG.CACHE_KEYS.CONFIG);
    cache.remove(CONFIG.CACHE_KEYS.PRODUCTS);
    cache.remove(CONFIG.CACHE_KEYS.STOCK);
  } catch (e) {}
}

function logAudit(info) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.AUDIT);
    if (!sheet) return;
    const record = [info.requestId || '', info.action || '', info.method || '', info.ip || '', info.userAgent || '', new Date().toISOString()];
    sheet.appendRow(record);
    const lastRow = sheet.getLastRow();
    if (lastRow > 5001) sheet.deleteRows(2, 1000);
  } catch (e) {}
}

function getClientIp() { try { return Session.getTemporaryActiveUserKey() || 'anonymous'; } catch (e) { return 'unknown'; } }

function healthCheck() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = {
    status: 'success',
    version: CONFIG.VERSION,
    timestamp: new Date().toISOString(),
    spreadsheet: { id: ss.getId(), name: ss.getName(), url: ss.getUrl() },
    sheets: {},
    quota: {},
    secrets: {}
  };
  for (const key in CONFIG.SHEET_NAMES) {
    const sheetName = CONFIG.SHEET_NAMES[key];
    const sheet = ss.getSheetByName(sheetName);
    if (sheet) result.sheets[key] = { name: sheetName, rows: sheet.getLastRow(), columns: sheet.getLastColumn(), status: 'ok' };
    else result.sheets[key] = { name: sheetName, status: 'missing' };
  }
  try { result.quota.emailQuota = MailApp.getRemainingDailyQuota(); } catch (e) { result.quota.emailQuota = 'N/A'; }
  result.secrets.LINE_CHANNEL_ACCESS_TOKEN = _getSecret('LINE_CHANNEL_ACCESS_TOKEN') ? 'set-in-properties' : 'fallback-in-code';
  result.secrets.LINE_CHANNEL_SECRET = _getSecret('LINE_CHANNEL_SECRET') ? 'set-in-properties' : 'fallback-in-code';
  result.secrets.LINE_ADMIN_USER_ID = _getSecret('LINE_ADMIN_USER_ID') ? 'set-in-properties' : 'fallback-in-code';
  return result;
}

function createBackup() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const file = DriveApp.getFileById(ss.getId());
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
    const backupName = 'BACKUP_' + ss.getName() + '_' + timestamp;
    const folderName = 'Kratom_POS_Backups';
    let folder;
    const existing = DriveApp.getFoldersByName(folderName);
    if (existing.hasNext()) folder = existing.next();
    else folder = DriveApp.createFolder(folderName);
    const backup = file.makeCopy(backupName, folder);
    return { status: 'success', message: 'Backup created', backupId: backup.getId(), backupName: backupName, backupUrl: backup.getUrl() };
  } catch (err) { return { status: 'error', message: 'Backup failed: ' + err.toString() }; }
}

// ============================================================================
// 📌 DATE/TIME HELPERS
// ============================================================================
function formatThaiDate(date) {
  const days = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  const months = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  const d = new Date(date);
  return 'วัน' + days[d.getDay()] + 'ที่ ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + (d.getFullYear() + 543);
}

function formatThaiDateShort(date) {
  const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const d = new Date(date);
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + String(d.getFullYear() + 543).slice(-2);
}

function looksLikeSaleAttempt(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^วันนี้/.test(t) || /^พรุ่งนี้/.test(t) || /^เมื่อวาน/.test(t)) return true;
  if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(t)) return true;
  return false;
}

// ============================================================================
// 📌 ANALYTICS HELPERS
// ============================================================================
function calcStats(logs, expenses, start, end) {
  const filteredLogs = logs.filter(l => { const d = new Date(l.timestamp); return d >= start && d < end; });
  const filteredExp = expenses.filter(e => { const d = new Date(e.timestamp); return d >= start && d < end; });
  const salesLogs = filteredLogs.filter(l => l.type === 'OUT');
  const revenue = salesLogs.reduce((s, l) => s + Number(l.total || 0), 0);
  const volume = salesLogs.reduce((s, l) => s + Number(l.qty || 0), 0);
  const totalExp = filteredExp.reduce((s, e) => s + Number(e.amount || 0), 0);
  return { revenue: revenue, volume: volume, txCount: salesLogs.length, expenses: totalExp, profit: revenue - totalExp };
}

function getFilteredDataByPeriod(period) {
  const data = getAllData();
  const now = new Date();
  let start, end = new Date(now.getTime() + 86400000);
  switch (period) {
    case 'today': start = new Date(now.getFullYear(), now.getMonth(), now.getDate()); break;
    case 'yesterday': start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1); end = new Date(now.getFullYear(), now.getMonth(), now.getDate()); break;
    case '7days': start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
    case 'thisMonth': start = new Date(now.getFullYear(), now.getMonth(), 1); break;
    case 'lastMonth': start = new Date(now.getFullYear(), now.getMonth() - 1, 1); end = new Date(now.getFullYear(), now.getMonth(), 1); break;
    default: start = new Date(0);
  }
  return {
    logs: data.logs.filter(l => { const d = new Date(l.timestamp); return d >= start && d <= end; }),
    expenses: data.expenses.filter(e => { const d = new Date(e.timestamp); return d >= start && d <= end; })
  };
}

function calculateStockForProduct(product) {
  // ใช้ StockBalance ถ้ามี
  try {
    const stockMap = readStockBalance();
    if (stockMap[product.id] !== undefined) return stockMap[product.id];
    if (stockMap['name:' + product.name] !== undefined) return stockMap['name:' + product.name];
  } catch (e) {}
  // Fallback: คำนวณสด
  const data = getAllData();
  const logs = data.logs.filter(l => l.productName === product.name);
  let inQty = 0, outQty = 0;
  logs.forEach(l => { if (l.type === 'IN') inQty += Number(l.qty || 0); if (l.type === 'OUT') outQty += Number(l.qty || 0); });
  return inQty - outQty;
}

function getUnitCostFromConfig(recipeType) {
  try {
    const config = readConfigAsObject(SpreadsheetApp.getActiveSpreadsheet());
    const leafCostPerKg = Number(config.costLeaves || 100);
    const ratio = Number(config.ratio || 25);
    const extract = Number(config.extractPercent || 80) / 100;
    const leafCostPerBottle = (1 / (ratio * extract)) * leafCostPerKg;
    const bottleCost = Number(config.costBottle || 5);
    const hiddenCost = Number(config.costHidden || 4);
    const base = Number(config.mixBaseWater || 21);
    const bottlePerL = Number(config.mixBottlePerLiter || 1);
    const yieldFactor = Math.max(0.01, Math.min(1, (Number(config.mixYieldPercent) || 90) / 100));
    const ings = recipeType === 'RED' ? config.redIngredients : config.bmIngredients;
    if (Array.isArray(ings) && ings.length > 0) {
      let totalCost = leafCostPerBottle + bottleCost + hiddenCost;
      const enabled = ings.filter(i => i.enabled !== false);
      let extraVolPerBase = 0;
      enabled.forEach(ing => { if (ing.unit === 'L') extraVolPerBase += ing.qty; else if (ing.unit === 'ml') extraVolPerBase += ing.qty / 1000; });
      const multiplier = 1 + extraVolPerBase / base;
      const rawPerBottle = 1 / (multiplier * yieldFactor * (bottlePerL || 1));
      enabled.forEach(ing => {
        const value = rawPerBottle * (ing.qty / base);
        const pricePer = ing.pricePer || 1;
        totalCost += value * (ing.price / pricePer);
      });
      return totalCost;
    }
    if (recipeType === 'RED') {
      const syrupCost = (Number(config.mixSyrupPerLiter || 20) / Number(config.mixSyrupPerBottle || 60)) * Number(config.costSyrupRed || 54);
      const cokeCost = (1 / 3) * Number(config.costCokeRed || 26);
      return leafCostPerBottle + bottleCost + hiddenCost + syrupCost + cokeCost;
    } else if (recipeType === 'ORIGINAL') {
      return leafCostPerBottle + bottleCost + hiddenCost;
    } else {
      const syrupCost = (Number(config.mixSyrupPerLiter || 20) / Number(config.mixSyrupPerBottle || 60)) * Number(config.costSyrupBm || 34);
      const cokeCost = (1 / 3) * Number(config.costCokeBm || 26);
      const plumCost = Number(config.mixPlumPerLiter || 3.33) * Number(config.costPlumBm || 1);
      return leafCostPerBottle + bottleCost + hiddenCost + syrupCost + cokeCost + plumCost;
    }
  } catch (e) { return 14; }
}

function getAverageUnitCost() {
  try {
    const config = readConfigAsObject(SpreadsheetApp.getActiveSpreadsheet());
    const leafCostPerKg = Number(config.costLeaves || 100);
    const ratio = Number(config.ratio || 25);
    const extract = Number(config.extractPercent || 80) / 100;
    const bottleCost = Number(config.costBottle || 5);
    const hiddenCost = Number(config.costHidden || 4);
    return leafCostPerKg / (ratio * extract) + bottleCost + hiddenCost + 15;
  } catch (e) { return 14; }
}

// ============================================================================
// 📌 SAFE HELPERS
// ============================================================================
function _n(v) { const x = Number(v); return isFinite(x) ? x : 0; }
function _pct(a, b) { return b > 0 ? (a / b) * 100 : 0; }
function _fmtK(v) {
  v = _n(v);
  if (Math.abs(v) >= 1000000) return '฿' + (v / 1000000).toFixed(2) + 'M';
  if (Math.abs(v) >= 1000) return '฿' + (v / 1000).toFixed(1) + 'K';
  return '฿' + Math.round(v);
}

// ============================================================================
// 📌 FLEX MESSAGE BUILDERS (shared primitives)
// ============================================================================
function createStatBox(label, value, color) {
  return {
    type: 'box', layout: 'vertical',
    contents: [
      { type: 'text', text: label, size: 'xs', color: '#9ca3af' },
      { type: 'text', text: value, size: 'md', color: color, weight: 'bold', margin: 'xs' }
    ],
    backgroundColor: '#0f1419', paddingAll: '10px', cornerRadius: '10px', flex: 1
  };
}

function createAnalysisRow(label, value, color) {
  return {
    type: 'box', layout: 'horizontal',
    contents: [
      { type: 'text', text: label, size: 'xs', color: '#9ca3af', flex: 5 },
      { type: 'text', text: value, size: 'xs', color: color, align: 'end', flex: 4, weight: 'bold' }
    ], margin: 'sm'
  };
}

function createSectionTitle(text, color) {
  return { type: 'text', text: text, weight: 'bold', color: color, size: 'sm', margin: 'md' };
}

function createQuickButton(text, color) {
  return {
    type: 'box', layout: 'vertical',
    contents: [{ type: 'text', text: text, size: 'xs', color: color, align: 'center', weight: 'bold' }],
    backgroundColor: '#0f1419', paddingAll: '8px', cornerRadius: '8px', flex: 1,
    action: { type: 'message', text: text }
  };
}

function createHelpSection(title, color, items) {
  const contents = [{ type: 'text', text: title, weight: 'bold', color: color, size: 'sm' }];
  items.forEach(function(item) {
    const cmd = item[0], desc = item[1];
    contents.push({
      type: 'box', layout: 'horizontal',
      contents: [
        { type: 'text', text: cmd, size: 'xs', color: color, weight: 'bold', flex: 3 },
        { type: 'text', text: desc, size: 'xxs', color: '#9ca3af', align: 'end', flex: 5, gravity: 'center' }
      ],
      margin: 'xs',
      action: { type: 'message', text: cmd }
    });
  });
  return { type: 'box', layout: 'vertical', contents: contents, margin: 'md' };
}

function generateQuickAdvice(score, netMargin, velocity) {
  const advices = [];
  if (netMargin < 0) advices.push('⚠️ ธุรกิจขาดทุน ต้องลดต้นทุนหรือเพิ่มราคา');
  else if (netMargin < 15) advices.push('📊 กำไรต่ำกว่าเกณฑ์ ควรทบทวนราคาและต้นทุน');
  else if (netMargin > 30) advices.push('✨ กำไรดีมาก รักษามาตรฐานไว้');
  if (velocity < 5) advices.push('📉 ยอดขายช้า ควรทำโปรโมชั่น');
  else if (velocity > 20) advices.push('🚀 ยอดขายดีมาก ควรเพิ่มสต๊อก');
  if (score < 50) advices.push('🎯 ต้องปรับปรุงหลายด้าน');
  else if (score >= 80) advices.push('🎉 ธุรกิจแข็งแรง ควรรักษาระดับนี้');
  return advices.join('\n') || 'ระบบทำงานปกติ';
}

function generateCashAdvice(finalNet, dailyNet, growthRate) {
  const advices = [];
  if (finalNet > 0 && dailyNet > 0) advices.push('✅ กระแสเงินสดเป็นบวก ควรเก็บสำรอง 20%');
  else if (finalNet < 0) { advices.push('⚠️ กระแสเงินสดติดลบ ต้องลดรายจ่าย'); advices.push('💡 เพิ่มยอดขายหรือลดต้นทุนวัตถุดิบ'); }
  if (growthRate > 0.02) advices.push('📈 แนวโน้มเติบโตดี พิจารณาลงทุนเพิ่ม');
  else if (growthRate < -0.02) advices.push('📉 ยอดขายลดลง ควรทำโปรโมชั่น');
  return advices.join('\n');
}

console.log('🍃 KRATOM POS v' + CONFIG.VERSION + ' — Part 1 loaded (Config, API, StockBalance)');
// ============================================================================
// 🚦 QUOTA GUARD (v16.0.2) — ป้องกันใช้เกินโควต้า LINE
// ============================================================================
const _lastReplyCache = {};
const _lastPushCache = {};

/**
 * ตรวจสอบว่าควรตอบหรือไม่ (กัน spam)
 * @param {string} userId
 * @returns {boolean} true = ควรตอบ, false = ควรข้าม
 */
function shouldReply(userId) {
  const now = Date.now();
  const last = _lastReplyCache[userId] || 0;
  if (now - last < CONFIG.QUOTA.MIN_REPLY_INTERVAL_MS) {
    console.log('[Quota] ⏭️ Skip reply — too soon (' + (now - last) + 'ms since last)');
    return false;
  }
  _lastReplyCache[userId] = now;
  return true;
}

/**
 * ตรวจสอบโควต้า Push (สำหรับ auto report)
 * @returns {boolean}
 */
function canPush() {
  if (!CONFIG.QUOTA.USE_REPLY_ONLY) return true;
  return true;  // auto report ยัง push ได้
}

/**
 * ตรวจสอบจำนวน push ที่ใช้ไปวันนี้ (สำหรับ admin)
 */
function getPushStats(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const pushKey = 'push_' + today + '_' + userId;
  const cache = CacheService.getScriptCache();
  return Number(cache.get(pushKey) || 0);
}

/**
 * Smart Aggregation — แนะนำ user ใช้ "สรุป" แทนหลายคำสั่ง
 */
function suggestAggregate(commandText) {
  const t = commandText.toLowerCase().trim();
  const aggregateTriggers = [
    'รายงานวันนี้', 'today', 'วันนี้',
    'รายงานสัปดาห์', 'weekly',
    'รายงานเดือน', 'monthly'
  ];
  if (aggregateTriggers.some(k => t === k)) {
    return true;
  }
  return false;
}

// ============================================================================
// 📌 LINE WEBHOOK & COMMAND HANDLERS
// ============================================================================
function handleLineWebhook(e, data) {
  const events = data.events || [];
  events.forEach(event => {
    try {
      if (!verifyLineSignature(e, LINE_CONFIG.CHANNEL_SECRET)) {
        console.warn('Invalid LINE signature — event ignored');
        return;
      }
      switch (event.type) {
        case 'message':
          if (event.message.type === 'text') handleTextMessage(event);
          else if (event.message.type === 'image') handleImageMessage(event);
          else if (event.message.type === 'location') handleLocationMessage(event);
          break;
        case 'follow': handleFollow(event); break;
        case 'unfollow': console.log('User unfollowed:', event.source.userId); break;
        case 'postback': handlePostback(event); break;
        case 'join': handleJoin(event); break;
      }
    } catch (err) { console.error('Event handling error:', err); }
  });
  return jsonResponse({ status: 'success' }, 200);
}

function verifyLineSignature(e, channelSecret) {
  try {
    const signature = e.parameter && e.parameter['x-line-signature'];
    if (!signature) return true;
    const body = e.postData.contents;
    const expectedSignature = Utilities.computeHmacSha256Signature(body, channelSecret);
    const expectedBase64 = Utilities.base64Encode(expectedSignature);
    return signature === expectedBase64;
  } catch (err) {
    console.error('verifyLineSignature error:', err);
    return false;
  }
}

function handleTextMessage(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const userText = (event.message.text || '').trim();
  console.log('Message from ' + userId + ': ' + userText);

  // 🚦 Quota Guard — กัน spam
  if (!shouldReply(userId)) {
    console.log('[Quota] ⏭️ Skipping reply for spam guard');
    return;
  }

  // ลอง parse sale command ก่อน
  const saleResult = parseSaleCommand(userText);
  if (saleResult) return handleSaleCommand(event, saleResult);

  if (looksLikeSaleAttempt(userText)) {
    return replyText(replyToken,
      '❓ ไม่เข้าใจรายการขายที่ระบุ\n\n' +
      '📝 รูปแบบที่ใช้ได้:\n' +
      '• วันนี้ ฝาแดง14 บีเอ็ม16 น้ำดิบ4\n' +
      '• พรุ่งนี้ A14 BM16 T4\n' +
      '• 15/10/26 A14 BM16 T4\n\n' +
      '🏷️ นามแฝง:\n' +
      '🔴 ฝาแดง, แดง, A, a\n' +
      '🟡 บีเอ็ม, บี, BM, B, bm, b\n' +
      '⚪ น้ำดิบ, น้ำ, ดิบ, T, t\n\n' +
      '💡 ตัวเลขคือจำนวนขวด');
  }

  const isAdmin = (userId === LINE_CONFIG.ADMIN_USER_ID);
  const command = parseCommand(userText);

  switch (command.action) {
    case 'summary': replySummaryAllInOne(replyToken); break;
    case 'dashboard': replyDashboard(replyToken); break;
    case 'dailyReport': replyDailyReport(replyToken); break;
    case 'weeklyReport': replyWeeklyReport(replyToken); break;
    case 'monthlyReport': replyMonthlyReport(replyToken); break;
    case 'weekly': replyWeeklyReport(replyToken); break;
    case 'monthly': replyMonthlyReport(replyToken); break;
    case 'today': replySalesReport(replyToken, 'today'); break;
    case 'yesterday': replySalesReport(replyToken, 'yesterday'); break;
    case '7days': replySalesReport(replyToken, '7days'); break;
    case 'month': replySalesReport(replyToken, 'thisMonth'); break;
    case 'profit': replyProfitReport(replyToken); break;
    case 'cost': replyCostAnalysis(replyToken); break;
    case 'stock': replyStockReport(replyToken); break;
    case 'top': replyTopProducts(replyToken); break;
    case 'productAnalysis': replyProductAnalysis(replyToken); break;
    case 'productDetail': replyProductDetail(replyToken, command.name); break;
    case 'marketShare': replyMarketShare(replyToken); break;
    case 'kpi': replyKPIDashboard(replyToken); break;
    case 'kpiTarget': replyKPITarget(replyToken); break;
    case 'setTarget': replySetTarget(replyToken, command.key, command.value); break;
    case 'trend': replyTrendAnalysis(replyToken); break;
    case 'compare': replyComparison(replyToken); break;
    case 'forecast': replyForecast(replyToken); break;
    case 'analysis': replyFullAnalysis(replyToken); break;
    case 'cashflow': replyCashFlow(replyToken); break;
    case 'cashflowForecast': replyCashFlowForecast(replyToken); break;
    case 'customer': replyCustomerStats(replyToken); break;

    /* 🎯 ADVANCED ANALYTICS */
    case 'salesKPIs': replySalesKPIDashboard(replyToken); break;
    case 'businessKPIs': replyBusinessKPIDashboard(replyToken); break;
    case 'deepAnalysis': replyDeepAnalysis(replyToken); break;
    case 'rfm': replyRFMAnalysis(replyToken); break;
    case 'abc': replyABCAnalysis(replyToken); break;
    case 'seasonal': replySeasonalAnalysis(replyToken); break;
    case 'basket': replyBasketAnalysis(replyToken); break;
    case 'cohort': replyCohortAnalysis(replyToken); break;

    case 'help': replyHelp(replyToken, isAdmin); break;
    case 'test':
      replyText(replyToken, '✅ ระบบทำงานปกติ\nVersion: ' + CONFIG.VERSION + '\nTimestamp: ' + new Date().toLocaleString('th-TH'));
      break;

    /* 🆕 ADVANCED KPI COMMANDS v16.0 */
    case 'clv': replyCLV(replyToken); break;
    case 'churn': replyChurn(replyToken); break;
    case 'segment': replySegment(replyToken); break;
    case 'aovTrend': replyAOVTrend(replyToken); break;
    case 'pnl': replyPnL(replyToken); break;
    case 'ratios': replyFinancialRatios(replyToken); break;
    case 'breakeven': replyBreakEven(replyToken); break;
    case 'sensitivity': replySensitivity(replyToken); break;
    case 'burnRate': replyBurnRate(replyToken); break;
    case 'runway': replyRunway(replyToken); break;
    case 'pareto': replyPareto(replyToken); break;
    case 'deadStock': replyDeadStock(replyToken); break;
    case 'crossSell': replyCrossSell(replyToken); break;
    case 'lifecycle': replyLifecycle(replyToken); break;
    case 'momGrowth': replyMoM(replyToken); break;
    case 'qoqGrowth': replyQoQ(replyToken); break;
    case 'yoyGrowth': replyYoY(replyToken); break;
    case 'cagr': replyCAGR(replyToken); break;
    case 'growthRate': replyGrowthRate(replyToken); break;
    case 'invTurnover': replyInvTurnover(replyToken); break;
    case 'dsi': replyDSI(replyToken); break;
    case 'dso': replyDSO(replyToken); break;
    case 'dpo': replyDPO(replyToken); break;
    case 'cashCycle': replyCashCycle(replyToken); break;
    case 'stockAlert': replyStockAlert(replyToken); break;
    case 'restock': replyRestock(replyToken); break;
    case 'velocity': replyVelocity(replyToken); break;
    case 'hhi': replyHHI(replyToken); break;
    case 'anomaly': replyAnomaly(replyToken); break;
    case 'hourlyPattern': replyHourlyPattern(replyToken); break;
    case 'weekdayPattern': replyWeekdayPattern(replyToken); break;
    case 'timeSlotPattern': replyTimeSlotPattern(replyToken); break;
    case 'topCustomers': replyTopCustomers(replyToken); break;
    case 'advancedDash': replyAdvancedDashboard(replyToken); break;
    case 'scorecard': replyScorecard(replyToken); break;
    case 'businessHealth': replyBusinessHealth(replyToken); break;
    case 'fullReport': replyFullReport(replyToken); break;
    case 'executiveSummary': replyExecutiveSummary(replyToken); break;

    default: replyUnknownCommand(replyToken, userText);
  }
}

// ============================================================================
// 📌 parseCommand
// ============================================================================
function parseCommand(text) {
  const t = text.toLowerCase().trim();

  // 🆕 ALL-IN-ONE SUMMARY (ประหยัดโควต้า)
  if (['สรุป', 'summary', 'สรุปทั้งหมด', 'all', 'allinone', 'ภาพรวม', 'overview'].includes(t)) {
    return { action: 'summary' };
  }

  if (['help', 'ช่วยเหลือ', 'เมนู', 'menu', '?', 'คำสั่ง'].includes(t)) return { action: 'help' };
  if (['แดชบอร์ด', 'dashboard'].includes(t)) return { action: 'dashboard' };
  if (['รายงาน', 'รายงานวันนี้', 'รายงานวัน', 'รายงานประจำวัน', 'dailyreport', 'daily report', 'daily'].includes(t)) return { action: 'dailyReport' };
  if (['รายงานสัปดาห์', 'รายงานสัปดาห์นี้', 'รายงานรายสัปดาห์', 'weeklyreport', 'weekly report', 'weekly'].includes(t)) return { action: 'weeklyReport' };
  if (['รายงานเดือน', 'รายงานเดือนนี้', 'รายงานรายเดือน', 'monthlyreport', 'monthly report', 'monthly'].includes(t)) return { action: 'monthlyReport' };
  if (['สัปดาห์นี้', 'thisweek'].includes(t)) return { action: 'weekly' };
  if (['รายเดือน'].includes(t)) return { action: 'monthly' };
  if (['วันนี้', 'today', 'ยอดวันนี้', 'สรุปวันนี้'].includes(t)) return { action: 'today' };
  if (['เมื่อวาน', 'yesterday', 'ยอดเมื่อวาน'].includes(t)) return { action: 'yesterday' };
  if (['7วัน', '7days'].includes(t)) return { action: '7days' };
  if (['เดือนนี้', 'month', 'thisMonth'].includes(t)) return { action: 'month' };
  if (['กำไร', 'profit', 'ขาดทุน', 'กำไรสุทธิ'].includes(t)) return { action: 'profit' };
  if (['ต้นทุน', 'cost', 'ค่าใช้จ่าย'].includes(t)) return { action: 'cost' };
  if (['สต๊อก', 'สต็อก', 'stock', 'คงเหลือ', 'inventory'].includes(t)) return { action: 'stock' };
  if (['ท็อป', 'ขายดี', 'top', 'อันดับ'].includes(t)) return { action: 'top' };
  if (['สินค้า', 'products', 'วิเคราะห์สินค้า'].includes(t)) return { action: 'productAnalysis' };

  if (['ประสิทธิภาพ', 'ประสิทธิภาพการขาย', 'saleskpi', 'sales kpi', 'sales-kpi', 'kpi การขาย', 'kpi ขาย', 'skpi'].includes(t)) return { action: 'salesKPIs' };
  if (['ตัวชี้วัดธุรกิจ', 'ตัวชี้วัด', 'businesskpi', 'business kpi', 'business-kpi', 'kpi ธุรกิจ', 'bkpi', 'kpi2'].includes(t)) return { action: 'businessKPIs' };
  if (['วิเคราะห์เชิงลึก', 'deep', 'deep-analysis', 'deepanalysis', 'เจาะลึก', 'ดีพ'].includes(t)) return { action: 'deepAnalysis' };
  if (['rfm', 'rfm analysis', 'จัดกลุ่มลูกค้า', 'แบ่งกลุ่มลูกค้า', 'วิเคราะห์ rfm', 'วิเคราะห์ลูกค้า'].includes(t)) return { action: 'rfm' };
  if (['abc', 'abc analysis', 'วิเคราะห์ abc'].includes(t)) return { action: 'abc' };
  if (['seasonal', 'seasonality', 'ฤดูกาล', 'ตามฤดู', 'ตามเดือน'].includes(t)) return { action: 'seasonal' };
  if (['basket', 'market basket', 'marketbasket', 'ตะกร้า', 'ซื้อคู่', 'วิเคราะห์ตะกร้า'].includes(t)) return { action: 'basket' };
  if (['cohort', 'cohort analysis', 'โคฮอร์ท', 'ลูกค้าใหม่', 'retention', 'วิเคราะห์กลุ่ม'].includes(t)) return { action: 'cohort' };

  if (t.startsWith('สินค้า ') || t.startsWith('product ')) {
    const name = text.replace(/^(สินค้า|product)\s+/i, '').trim();
    return { action: 'productDetail', name: name };
  }
  if (['สัดส่วนตลาด', 'marketshare', 'ส่วนแบ่ง'].includes(t)) return { action: 'marketShare' };
  if (['kpi', 'kpi ทั้งหมด', 'ตัวชี้วัด'].includes(t)) return { action: 'kpi' };
  if (['เป้าหมาย', 'target', 'goal'].includes(t)) return { action: 'kpiTarget' };
  if (['แนวโน้ม', 'trend', 'เทรนด์'].includes(t)) return { action: 'trend' };
  if (['เปรียบเทียบ', 'compare', 'เทียบ'].includes(t)) return { action: 'compare' };
  if (['พยากรณ์', 'forecast', 'คาดการณ์', 'ทำนาย'].includes(t)) return { action: 'forecast' };
  if (['วิเคราะห์', 'analysis', 'report', 'bi'].includes(t)) return { action: 'analysis' };
  if (['cashflow', 'กระแสเงินสด', 'เงินสด'].includes(t)) return { action: 'cashflow' };
  if (['พยากรณ์เงิน', 'forecastcash', 'คาดการณ์เงินสด'].includes(t)) return { action: 'cashflowForecast' };
  if (['ลูกค้า', 'customer', 'บิล'].includes(t)) return { action: 'customer' };
  if (['test', 'ทดสอบ', 'ping'].includes(t)) return { action: 'test' };
  if (t.startsWith('ตั้งเป้า ') || t.startsWith('target ')) {
    const parts = t.split(/\s+/);
    if (parts.length >= 3) return { action: 'setTarget', key: parts[1], value: parts[2] };
  }

  if (['clv', 'ltv', 'customer lifetime value', 'มูลค่าลูกค้า'].includes(t)) return { action: 'clv' };
  if (['churn', 'churn rate', 'อัตราลูกค้าหาย', 'ลูกค้าหลุด'].includes(t)) return { action: 'churn' };
  if (['segment', 'segmentation', 'แบ่งกลุ่มลูกค้า', 'กลุ่มลูกค้า'].includes(t)) return { action: 'segment' };
  if (['aov', 'aov trend', 'basket size', 'ขนาดตะกร้า'].includes(t)) return { action: 'aovTrend' };
  if (['pnl', 'p&l', 'กำไรขาดทุน', 'งบกำไรขาดทุน'].includes(t)) return { action: 'pnl' };
  if (['ratios', 'ratio', 'อัตราส่วน', 'อัตราส่วนการเงิน'].includes(t)) return { action: 'ratios' };
  if (['breakeven', 'break-even', 'be', 'จุดคุ้มทุน'].includes(t)) return { action: 'breakeven' };
  if (['sensitivity', 'sensitivity analysis', 'ความอ่อนไหว', 'what-if', 'whatif'].includes(t)) return { action: 'sensitivity' };
  if (['burn rate', 'burnrate', 'อัตราการใช้เงิน'].includes(t)) return { action: 'burnRate' };
  if (['runway', 'cash runway', 'cash runway days'].includes(t)) return { action: 'runway' };
  if (['pareto', 'pareto analysis', 'พาเรโต'].includes(t)) return { action: 'pareto' };
  if (['deadstock', 'dead stock', 'สินค้าค้าง', 'สินค้าขายไม่ออก', 'dead'].includes(t)) return { action: 'deadStock' };
  if (['crosssell', 'cross sell', 'cross-sell', 'ขายไขว้'].includes(t)) return { action: 'crossSell' };
  if (['lifecycle', 'life cycle', 'product lifecycle', 'วงจรสินค้า'].includes(t)) return { action: 'lifecycle' };
  if (['mom', 'mom growth', 'month over month'].includes(t)) return { action: 'momGrowth' };
  if (['qoq', 'qoq growth', 'quarter over quarter'].includes(t)) return { action: 'qoqGrowth' };
  if (['yoy', 'yoy growth', 'year over year'].includes(t)) return { action: 'yoyGrowth' };
  if (['cagr', 'compound annual growth rate'].includes(t)) return { action: 'cagr' };
  if (['growth', 'growth rate', 'อัตราเติบโต', 'การเติบโต'].includes(t)) return { action: 'growthRate' };
  if (['invturnover', 'inventory turnover', 'หมุนเวียนสต๊อก', 'การหมุนเวียนสินค้า'].includes(t)) return { action: 'invTurnover' };
  if (['dsi', 'days sales inventory', 'days inventory', 'จำนวนวันขายสต๊อก'].includes(t)) return { action: 'dsi' };
  if (['dso', 'days sales outstanding', 'ระยะเวลาเก็บเงิน'].includes(t)) return { action: 'dso' };
  if (['dpo', 'days payable outstanding', 'ระยะเวลาจ่ายเงิน'].includes(t)) return { action: 'dpo' };
  if (['cashcycle', 'cash cycle', 'วงจรเงินสด', 'ccc'].includes(t)) return { action: 'cashCycle' };
  if (['alert', 'stockalert', 'stock alert', 'แจ้งเตือนสต๊อก', 'สต๊อกต่ำ'].includes(t)) return { action: 'stockAlert' };
  if (['restock', 'restock rec', 'ควรเติม', 'แนะนำเติม'].includes(t)) return { action: 'restock' };
  if (['velocity', 'sales velocity', 'ความเร็วขาย', 'ความเร็ว'].includes(t)) return { action: 'velocity' };
  if (['hhi', 'concentration', 'hhi index', 'ดัชนีการกระจุกตัว'].includes(t)) return { action: 'hhi' };
  if (['anomaly', 'anomaly detection', 'ผิดปกติ', 'ค่าผิดปกติ'].includes(t)) return { action: 'anomaly' };
  if (['hourly', 'hourly pattern', 'รายชั่วโมง', 'ตามชั่วโมง'].includes(t)) return { action: 'hourlyPattern' };
  if (['weekday', 'weekday pattern', 'รายวัน', 'ตามวัน'].includes(t)) return { action: 'weekdayPattern' };
  if (['timeslot', 'time slot', 'ช่วงเวลา'].includes(t)) return { action: 'timeSlotPattern' };
  if (['topcustomer', 'top customer', 'ลูกค้าชั้นนำ'].includes(t)) return { action: 'topCustomers' };
  if (['advanced', 'advanced dash', 'advanced dashboard', 'แดชบอร์ดขั้นสูง'].includes(t)) return { action: 'advancedDash' };
  if (['scorecard', 'score', 'คะแนน', 'scorecard bi'].includes(t)) return { action: 'scorecard' };
  if (['health', 'healthcheck', 'business health', 'สุขภาพธุรกิจ'].includes(t)) return { action: 'businessHealth' };
  if (['fullreport', 'full report', 'รายงานเต็ม', 'รายงานครบ'].includes(t)) return { action: 'fullReport' };
  if (['executive', 'executive summary', 'สรุปผู้บริหาร'].includes(t)) return { action: 'executiveSummary' };

  return { action: 'unknown', text: text };
}

// ============================================================================
// 🛒 SALE COMMAND PARSER
// ============================================================================
function parseSaleCommand(text) {
  const originalText = String(text || '').trim();
  if (!originalText) return null;
  const t = originalText.toLowerCase();
  let saleDate = null;
  let rest = t;

  if (t.indexOf('วันนี้') === 0) { saleDate = new Date(); rest = t.replace(/^วันนี้\s*/, '').trim(); }
  else if (t.indexOf('พรุ่งนี้') === 0) { saleDate = new Date(Date.now() + 86400000); rest = t.replace(/^พรุ่งนี้\s*/, '').trim(); }
  else if (t.indexOf('เมื่อวาน') === 0) { saleDate = new Date(Date.now() - 86400000); rest = t.replace(/^เมื่อวาน\s*/, '').trim(); }
  else {
    const dm = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\s*/);
    if (dm) {
      let y = Number(dm[3]);
      if (y < 100) y += (y < 50 ? 2000 : 1900);
      const dd = Number(dm[1]);
      const mm = Number(dm[2]);
      if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
      saleDate = new Date(y, mm - 1, dd);
      rest = t.substring(dm[0].length).trim();
    }
  }
  if (!saleDate) return null;
  if (!rest) return null;

  saleDate.setHours(12, 0, 0, 0);

  const allAliases = [];
  for (const rt in SALE_ALIASES) {
    for (let i = 0; i < SALE_ALIASES[rt].length; i++) {
      allAliases.push({ alias: SALE_ALIASES[rt][i].toLowerCase(), recipeType: rt });
    }
  }
  allAliases.sort(function(a, b) { return b.alias.length - a.alias.length; });

  const items = [];
  const consumed = [];

  for (let ai = 0; ai < allAliases.length; ai++) {
    const entry = allAliases[ai];
    const escaped = entry.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?:^|\\s)(' + escaped + ')\\s*(\\d+(?:\\.\\d+)?)', 'gi');
    let m;
    while ((m = re.exec(rest)) !== null) {
      const startPos = m.index + m[0].indexOf(m[1]);
      const endPos = m.index + m[0].length;
      const overlaps = consumed.some(function(r) { return !(endPos <= r.start || startPos >= r.end); });
      if (!overlaps) {
        items.push({ recipeType: entry.recipeType, qty: parseFloat(m[2]), alias: m[1] });
        consumed.push({ start: startPos, end: endPos });
      }
    }
  }
  if (items.length === 0) return null;
  return { saleDate: saleDate, items: items, originalText: originalText };
}

// ============================================================================
// 📌 SALE RECORDING FROM LINE
// ============================================================================
function findProductForSale(recipeType) {
  const products = getProducts().products || [];
  let product = products.find(function(p) { return p.recipeType === recipeType && p.status === 'ACTIVE'; });
  if (!product) product = products.find(function(p) { return p.recipeType === recipeType; });
  if (!product && recipeType === 'ORIGINAL') {
    const newProduct = { id: 'P_ORIGINAL', name: 'น้ำดิบ Original (1000ml)', recipeType: 'ORIGINAL', price: 25, status: 'ACTIVE' };
    saveProduct(newProduct);
    product = newProduct;
  }
  return product;
}

function recordSaleFromLine(parsed, recorderName, userId) {
  const results = [];
  const errors = [];
  for (let i = 0; i < parsed.items.length; i++) {
    const item = parsed.items[i];
    const product = findProductForSale(item.recipeType);
    if (!product) { errors.push('ไม่พบสินค้าสูตร ' + item.recipeType); continue; }
    const unitPrice = Number(product.price) || 35;
    const log = {
      id: 'TX_LINE_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      timestamp: parsed.saleDate.toISOString(),
      type: 'OUT',
      qty: item.qty,
      unitPrice: unitPrice,
      total: item.qty * unitPrice,
      source: 'LINE_BOT',
      paymentMethod: 'CASH',
      recipeType: item.recipeType,
      productName: product.name,
      action: 'LINE_SALE',
      note: 'บันทึกผ่าน LINE Bot' + (recorderName ? ' โดย ' + recorderName : ''),
      createdBy: userId || 'line_user'
    };
    const r = addLog(log);
    if (r.status === 'success') {
      results.push({ item: item, log: log, product: product, stockUpdate: r.stockUpdate });
    } else {
      errors.push(r.message || 'ไม่ทราบสาเหตุ');
    }
  }
  return { results: results, errors: errors, recorderName: recorderName };
}

function handleSaleCommand(event, parsed) {
  const replyToken = event.replyToken;
  const userId = event.source.userId;

  let recorderName = 'ไม่ทราบ';
  let recorderId = userId || '';
  try {
    const profile = getLineProfile(userId);
    if (profile && profile.displayName) recorderName = profile.displayName;
  } catch (e) { /* default */ }

  const result = recordSaleFromLine(parsed, recorderName, recorderId);

  if (result.results.length === 0) {
    return replySaleError(replyToken, parsed, result.errors);
  }
  return replySaleConfirmation(replyToken, parsed, result);
}

function replySaleConfirmation(replyToken, parsed, result) {
  let totalQty = 0, totalRev = 0;
  const rows = [];
  for (let i = 0; i < result.results.length; i++) {
    const r = result.results[i];
    const rt = r.item.recipeType;
    const emoji = rt === 'RED' ? '🔴' : rt === 'BM' ? '🟡' : rt === 'ORIGINAL' ? '⚪' : '📦';
    const color = rt === 'RED' ? '#ef4444' : rt === 'BM' ? '#f59e0b' : rt === 'ORIGINAL' ? '#9ca3af' : '#6b7280';
    totalQty += r.log.qty;
    totalRev += r.log.total;
    const stockAfter = r.stockUpdate ? r.stockUpdate.newBalance : null;
    rows.push({
      type: 'box', layout: 'horizontal',
      contents: [
        { type: 'text', text: emoji + ' ' + (r.product.name.length > 20 ? r.product.name.substring(0, 20) + '...' : r.product.name), size: 'sm', color: '#e5e7eb', flex: 5, wrap: true },
        { type: 'text', text: r.log.qty + ' ขวด', size: 'sm', color: color, align: 'end', flex: 2, weight: 'bold' },
        { type: 'text', text: '฿' + Math.round(r.log.total).toLocaleString(), size: 'sm', color: '#10b981', align: 'end', flex: 3, weight: 'bold' }
      ], margin: 'md'
    });
    if (stockAfter !== null) {
      rows.push({
        type: 'text',
        text: '   └─ คงเหลือ ' + stockAfter + ' ขวด',
        size: 'xxs',
        color: stockAfter <= 5 ? '#ef4444' : '#6b7280',
        margin: 'xs'
      });
    }
  }

  const partialErrors = (result.errors && result.errors.length > 0) ? result.errors : [];
  const errorBlock = partialErrors.length > 0 ? {
    type: 'box', layout: 'vertical',
    contents: [
      { type: 'text', text: '⚠️ บางรายการล้มเหลว', color: '#f59e0b', size: 'xs', weight: 'bold' },
      ...partialErrors.map(function(e) { return { type: 'text', text: '• ' + e, size: 'xxs', color: '#ef4444', wrap: true, margin: 'xs' }; })
    ],
    backgroundColor: '#2a1f05', paddingAll: '8px', cornerRadius: '8px', margin: 'md'
  } : null;

  const bodyContents = [
    { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: '💰 ยอดรวม', color: '#9ca3af', size: 'xs' },
      { type: 'text', text: '฿' + Math.round(totalRev).toLocaleString(), color: '#10b981', size: 'xxl', weight: 'bold', margin: 'xs' },
      { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm', contents: [
        { type: 'text', text: '📦 ' + totalQty + ' ขวด', color: '#3b82f6', size: 'xs', flex: 1 },
        { type: 'text', text: '🧾 ' + result.results.length + ' รายการ', color: '#8b5cf6', size: 'xs', align: 'end', flex: 1 }
      ]}
    ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
    { type: 'separator', margin: 'lg' },
    { type: 'text', text: '📋 รายละเอียด', weight: 'bold', color: '#ffffff', size: 'sm', margin: 'md' },
    ...rows,
    ...(errorBlock ? [errorBlock] : []),
    { type: 'separator', margin: 'lg' },
    { type: 'box', layout: 'horizontal', contents: [
      { type: 'text', text: 'ชำระ', color: '#9ca3af', size: 'xs', flex: 3 },
      { type: 'text', text: '💵 เงินสด', color: '#10b981', size: 'xs', align: 'end', flex: 3, weight: 'bold' }
    ], margin: 'md' },
    { type: 'box', layout: 'horizontal', contents: [
      { type: 'text', text: '👤 บันทึกโดย', color: '#6b7280', size: 'xxs', flex: 3 },
      { type: 'text', text: result.recorderName || 'ไม่ทราบ', color: '#a78bfa', size: 'xxs', align: 'end', flex: 5, weight: 'bold' }
    ], margin: 'sm' },
    { type: 'text', text: '💡 แก้ไข/ลบได้ที่หน้าเว็บ KRATOM POS', color: '#6b7280', size: 'xs', margin: 'sm', wrap: true }
  ];

  const flexMessage = {
    type: 'flex',
    altText: (partialErrors.length > 0 ? '⚠️ บันทึกบางส่วน ' : '✅ บันทึกการขายสำเร็จ ') + '฿' + Math.round(totalRev).toLocaleString(),
    contents: {
      type: 'bubble', size: 'giga',
      header: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'text', text: partialErrors.length > 0 ? '⚠️ บันทึกสำเร็จบางส่วน' : '✅ บันทึกการขายสำเร็จ', weight: 'bold', color: partialErrors.length > 0 ? '#f59e0b' : '#10b981', size: 'lg' },
          { type: 'text', text: '📅 ' + formatThaiDate(parsed.saleDate), color: '#9ca3af', size: 'xs', margin: 'sm' }
        ],
        backgroundColor: '#0a0c10', paddingAll: '16px'
      },
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: bodyContents, paddingAll: '16px' },
      styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
    }
  };
  replyFlex(replyToken, flexMessage);
}

function replySaleError(replyToken, parsed, errors) {
  const text = '❌ บันทึกไม่สำเร็จ\n\n' +
    '📅 ' + formatThaiDate(parsed.saleDate) + '\n' +
    '📋 รายการ: ' + parsed.items.length + ' อย่าง\n\n' +
    '⚠️ ข้อผิดพลาด:\n' +
    errors.map(function(e) { return '• ' + e; }).join('\n') +
    '\n\n💡 ตรวจสอบว่ามีสินค้าในระบบแล้วหรือไม่';
  replyText(replyToken, text);
}

// ============================================================================
// 📌 LINE REPLY HELPERS — WITH QUOTA LOGGING
// ============================================================================
function replyText(replyToken, text) {
  try {
    const url = LINE_CONFIG.API_ENDPOINT + '/message/reply';
    const response = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_CONFIG.CHANNEL_ACCESS_TOKEN },
      payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }),
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    if (code === 200) {
      console.log('[Quota] ✅ replyText used (no charge)');
    } else {
      console.warn('[Quota] ⚠️ replyText failed:', code, response.getContentText().substring(0, 200));
    }
    return response;
  } catch (err) { console.error('replyText error:', err); }
}

function replyFlex(replyToken, flexMessage) {
  try {
    const url = LINE_CONFIG.API_ENDPOINT + '/message/reply';
    const response = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_CONFIG.CHANNEL_ACCESS_TOKEN },
      payload: JSON.stringify({ replyToken: replyToken, messages: [flexMessage] }),
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    if (code === 200) {
      console.log('[Quota] ✅ replyFlex used (no charge)');
    } else {
      console.warn('[Quota] ⚠️ replyFlex failed:', code, response.getContentText().substring(0, 200));
    }
    return response;
  } catch (err) { console.error('replyFlex error:', err); }
}

function pushMessage(userId, messages) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const pushKey = 'push_' + today + '_' + userId;
    const cache = CacheService.getScriptCache();
    const pushCount = Number(cache.get(pushKey) || 0);
    const maxPush = CONFIG.QUOTA.MAX_PUSH_PER_USER_PER_DAY || 5;

    if (pushCount >= maxPush) {
      console.warn('[Quota] ⛔ Push limit reached for user ' + userId + ' today (' + pushCount + '/' + maxPush + ')');
      return null;
    }

    const url = LINE_CONFIG.API_ENDPOINT + '/message/push';
    const response = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_CONFIG.CHANNEL_ACCESS_TOKEN },
      payload: JSON.stringify({ to: userId, messages: Array.isArray(messages) ? messages : [messages] }),
      muteHttpExceptions: true
    });

    if (response.getResponseCode() === 200) {
      cache.put(pushKey, String(pushCount + 1), 86400);
      console.log('[Quota] 📤 Push #' + (pushCount + 1) + '/' + maxPush + ' used for ' + userId);
    }

    return response;
  } catch (err) { console.error('pushMessage error:', err); }
}

function getLineProfile(userId) {
  try {
    const url = LINE_CONFIG.API_ENDPOINT + '/profile/' + userId;
    const response = UrlFetchApp.fetch(url, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + LINE_CONFIG.CHANNEL_ACCESS_TOKEN },
      muteHttpExceptions: true
    });
    return JSON.parse(response.getContentText());
  } catch (err) { return {}; }
}

// ============================================================================
// 📌 SIMPLE MESSAGE HANDLERS
// ============================================================================
function handleImageMessage(event) {
  replyText(event.replyToken, '📷 ได้รับรูปภาพแล้ว\n\nขณะนี้ยังไม่รองรับการอ่านรูปภาพ');
}

function handleLocationMessage(event) {
  replyText(event.replyToken, '📍 ได้รับตำแหน่งแล้ว');
}

function handlePostback(event) {
  console.log('Postback:', JSON.stringify(event.postback));
}

function handleFollow(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  try {
    const profile = getLineProfile(userId);
    console.log('New follower:', profile.displayName);
  } catch (e) {}
  replyText(replyToken,
    '🍃 ยินดีต้อนรับสู่ KRATOM POS Bot!\n\n' +
    '📊 ระบบวิเคราะห์ข้อมูลธุรกิจอัจฉริยะ v' + CONFIG.VERSION + '\n' +
    '✨ บันทึกการขายผ่าน LINE ได้เลย!\n\n' +
    '🛒 ตัวอย่างบันทึกขาย:\n' +
    '• วันนี้ ฝาแดง14 บีเอ็ม16 น้ำดิบ4\n' +
    '• พรุ่งนี้ A14 BM16 T4\n' +
    '• 15/10/26 A14 BM16 T4\n\n' +
    '📊 รายงานสวยงาม:\n' +
    '• สรุป (ทุกอย่างใน 1 ข้อความ)\n' +
    '• รายงานวันนี้\n' +
    '• รายงานสัปดาห์\n' +
    '• รายงานเดือน\n\n' +
    '🎯 KPI ขั้นสูง:\n' +
    '• rfm · clv · churn · pnl\n' +
    '• abc · pareto · breakeven\n' +
    '• scorecard · health · executive\n\n' +
    '💡 พิมพ์ "ช่วยเหลือ" เพื่อดูทั้งหมด');
}

function handleJoin(event) {
  replyText(event.replyToken, '🍃 ขอบคุณที่เชิญ Kratom POS Bot เข้ากลุ่ม!\nพิมพ์ "ช่วยเหลือ" เพื่อดูคำสั่ง');
}

// ============================================================================
// 🎯 ALL-IN-ONE SUMMARY — ตอบ 1 ครั้ง ได้ทุกข้อมูล (ประหยัดโควต้า)
// ============================================================================
function replySummaryAllInOne(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();

    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now.getTime() - 7 * 86400000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const today = calcStats(data.logs, data.expenses, todayStart, now);
    const week = calcStats(data.logs, data.expenses, weekStart, now);
    const month = calcStats(data.logs, data.expenses, monthStart, now);
    const lastMonth = calcStats(data.logs, data.expenses, lastMonthStart, monthStart);

    const growth = lastMonth.revenue > 0
      ? ((month.revenue - lastMonth.revenue) / lastMonth.revenue) * 100
      : 0;
    const netMargin = month.revenue > 0 ? (month.profit / month.revenue) * 100 : 0;

    const stockMap = readStockBalance();
    let totalStock = 0, lowStockCount = 0, stockRows = [];
    (data.products || []).forEach(p => {
      const s = stockMap[p.id] !== undefined ? stockMap[p.id] : (stockMap['name:' + p.name] || 0);
      totalStock += Math.max(0, s);
      if (s <= 5) lowStockCount++;
      const emoji = p.recipeType === 'RED' ? '🔴' : p.recipeType === 'BM' ? '🟡' : '⚪';
      stockRows.push({ emoji: emoji, name: p.name, stock: s });
    });

    const t30 = new Date(now.getTime() - 30 * 86400000);
    const recentSales = (data.logs || []).filter(l => l.type === 'OUT' && new Date(l.timestamp) >= t30);
    const prodMap = {};
    recentSales.forEach(l => {
      if (!prodMap[l.productName]) prodMap[l.productName] = { qty: 0, rev: 0 };
      prodMap[l.productName].qty += Number(l.qty || 0);
      prodMap[l.productName].rev += Number(l.total || 0);
    });
    const top3 = Object.keys(prodMap)
      .sort((a, b) => prodMap[b].qty - prodMap[a].qty)
      .slice(0, 3);

    const growthColor = growth >= 0 ? '#10b981' : '#ef4444';
    const growthEmoji = growth >= 0 ? '📈' : '📉';
    const marginColor = netMargin >= 20 ? '#10b981' : netMargin >= 0 ? '#f59e0b' : '#ef4444';

    const flexMessage = {
      type: 'flex',
      altText: 'สรุป · วันนี้ ฿' + Math.round(today.revenue).toLocaleString() + ' · เดือน ฿' + Math.round(month.revenue).toLocaleString(),
      contents: {
        type: 'bubble',
        size: 'giga',
        header: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '📊 สรุปภาพรวม', weight: 'bold', color: '#10b981', size: 'xl' },
            { type: 'text', text: formatThaiDate(now), color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10',
          paddingAll: '16px'
        },
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          contents: [
            {
              type: 'box',
              layout: 'vertical',
              contents: [
                { type: 'text', text: '🌅 วันนี้', color: '#10b981', size: 'xs', weight: 'bold' },
                {
                  type: 'box',
                  layout: 'horizontal',
                  contents: [
                    { type: 'text', text: '💰 ฿' + Math.round(today.revenue).toLocaleString(), color: '#10b981', size: 'lg', weight: 'bold', flex: 1 },
                    { type: 'text', text: today.volume + ' ขวด', color: '#3b82f6', size: 'sm', align: 'end', flex: 1, gravity: 'center' },
                    { type: 'text', text: today.txCount + ' บิล', color: '#8b5cf6', size: 'sm', align: 'end', flex: 1, gravity: 'center' }
                  ],
                  margin: 'xs'
                }
              ],
              backgroundColor: '#0f1419',
              paddingAll: '10px',
              cornerRadius: '10px'
            },
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                { type: 'text', text: '📅 7 วัน', color: '#9ca3af', size: 'xs', flex: 3, gravity: 'center' },
                { type: 'text', text: '฿' + Math.round(week.revenue).toLocaleString(), color: '#10b981', size: 'sm', weight: 'bold', align: 'end', flex: 3, gravity: 'center' },
                { type: 'text', text: week.volume + ' ขวด', color: '#3b82f6', size: 'xs', align: 'end', flex: 2, gravity: 'center' }
              ],
              paddingAll: '8px',
              backgroundColor: '#0a0c10',
              cornerRadius: '8px'
            },
            {
              type: 'box',
              layout: 'vertical',
              contents: [
                { type: 'text', text: '📆 เดือนนี้', color: '#f59e0b', size: 'xs', weight: 'bold' },
                {
                  type: 'box',
                  layout: 'horizontal',
                  contents: [
                    { type: 'text', text: '💰 ฿' + Math.round(month.revenue).toLocaleString(), color: '#10b981', size: 'lg', weight: 'bold', flex: 1 },
                    { type: 'text', text: growthEmoji + ' ' + (growth >= 0 ? '+' : '') + growth.toFixed(1) + '%', color: growthColor, size: 'sm', align: 'end', flex: 1, gravity: 'center' }
                  ],
                  margin: 'xs'
                },
                {
                  type: 'box',
                  layout: 'horizontal',
                  contents: [
                    { type: 'text', text: 'กำไร ฿' + Math.round(month.profit).toLocaleString(), color: month.profit >= 0 ? '#10b981' : '#ef4444', size: 'xs', flex: 1 },
                    { type: 'text', text: 'Margin ' + netMargin.toFixed(1) + '%', color: marginColor, size: 'xs', align: 'end', flex: 1 }
                  ],
                  margin: 'xs'
                }
              ],
              backgroundColor: '#0f1419',
              paddingAll: '10px',
              cornerRadius: '10px'
            },
            { type: 'separator', margin: 'md' },
            {
              type: 'box',
              layout: 'vertical',
              contents: [
                {
                  type: 'box',
                  layout: 'horizontal',
                  contents: [
                    { type: 'text', text: '📦 สต๊อก', color: '#8b5cf6', size: 'xs', weight: 'bold', flex: 1 },
                    { type: 'text', text: 'รวม ' + totalStock + ' ขวด', color: '#3b82f6', size: 'xs', align: 'end', flex: 1 }
                  ]
                },
                ...stockRows.map(function(r) {
                  return {
                    type: 'box',
                    layout: 'horizontal',
                    contents: [
                      { type: 'text', text: r.emoji + ' ' + (r.name.length > 20 ? r.name.substring(0, 20) + '...' : r.name), color: '#e5e7eb', size: 'xs', flex: 5, wrap: true },
                      { type: 'text', text: r.stock + ' ขวด', color: r.stock <= 5 ? '#ef4444' : r.stock <= 15 ? '#f59e0b' : '#10b981', size: 'xs', align: 'end', flex: 2, weight: 'bold' }
                    ],
                    margin: 'xs'
                  };
                }),
                lowStockCount > 0 ? {
                  type: 'text',
                  text: '⚠️ ' + lowStockCount + ' รายการต้องเติม',
                  color: '#f59e0b',
                  size: 'xs',
                  margin: 'sm',
                  weight: 'bold'
                } : { type: 'filler' }
              ],
              backgroundColor: '#0f1419',
              paddingAll: '10px',
              cornerRadius: '10px'
            },
            { type: 'separator', margin: 'md' },
            {
              type: 'box',
              layout: 'vertical',
              contents: [
                { type: 'text', text: '🏆 Top 3 สินค้าขายดี (30 วัน)', color: '#f59e0b', size: 'xs', weight: 'bold' }
              ].concat(top3.map(function(name, i) {
                const medal = ['🥇', '🥈', '🥉'][i];
                const p = prodMap[name];
                return {
                  type: 'box',
                  layout: 'horizontal',
                  contents: [
                    { type: 'text', text: medal + ' ' + (name.length > 20 ? name.substring(0, 20) + '...' : name), color: '#e5e7eb', size: 'xs', flex: 5, wrap: true },
                    { type: 'text', text: p.qty + ' ขวด', color: '#10b981', size: 'xs', align: 'end', flex: 2, weight: 'bold' }
                  ],
                  margin: 'xs'
                };
              })),
              backgroundColor: '#0f1419',
              paddingAll: '10px',
              cornerRadius: '10px'
            },
            { type: 'separator', margin: 'md' },
            {
              type: 'text',
              text: '💡 พิมพ์ "รายงานวันนี้" สำหรับรายละเอียด',
              color: '#6b7280',
              size: 'xxs',
              wrap: true,
              margin: 'sm'
            }
          ],
          paddingAll: '16px'
        },
        styles: {
          header: { backgroundColor: '#0a0c10' },
          body: { backgroundColor: '#0a0c10' }
        }
      }
    };

    replyFlex(replyToken, flexMessage);
  } catch (err) {
    console.error('replySummaryAllInOne error:', err);
    replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString());
  }
}

// ============================================================================
// 📊 BEAUTIFUL REPORT — DAILY
// ============================================================================
function buildDailyReportFlex(targetDate) {
  const data = getAllData();
  const d = targetDate ? new Date(targetDate) : new Date();
  d.setHours(0, 0, 0, 0);
  const dayStart = d;
  const dayEnd = new Date(d.getTime() + 86400000);
  const yStart = new Date(d.getTime() - 86400000);
  const today = calcStats(data.logs, data.expenses, dayStart, dayEnd);
  const yesterday = calcStats(data.logs, data.expenses, yStart, dayStart);

  const sales = (data.logs || []).filter(function(l) {
    if (l.type !== 'OUT') return false;
    const ld = new Date(l.timestamp);
    return ld >= dayStart && ld < dayEnd;
  });

  const byProduct = {};
  sales.forEach(function(l) {
    const key = l.productName || 'ไม่ทราบ';
    if (!byProduct[key]) byProduct[key] = { qty: 0, rev: 0, rt: l.recipeType || '' };
    byProduct[key].qty += Number(l.qty || 0);
    byProduct[key].rev += Number(l.total || 0);
  });
  const sortedProducts = Object.keys(byProduct).sort(function(a, b) { return byProduct[b].qty - byProduct[a].qty; });

  const growth = yesterday.revenue > 0 ? ((today.revenue - yesterday.revenue) / yesterday.revenue) * 100 : 0;
  const growthEmoji = growth >= 0 ? '📈' : '📉';
  const growthColor = growth >= 0 ? '#10b981' : '#ef4444';
  const growthText = (growth >= 0 ? '+' : '') + growth.toFixed(1) + '%';

  const productRows = sortedProducts.map(function(name) {
    const p = byProduct[name];
    const ri = p.rt === 'RED' ? { emoji: '🔴', color: '#ef4444' } :
               p.rt === 'BM' ? { emoji: '🟡', color: '#f59e0b' } :
               p.rt === 'ORIGINAL' ? { emoji: '⚪', color: '#9ca3af' } : { emoji: '📦', color: '#6b7280' };
    return {
      type: 'box', layout: 'horizontal',
      contents: [
        { type: 'text', text: ri.emoji + ' ' + (name.length > 22 ? name.substring(0, 22) + '...' : name), size: 'sm', color: '#e5e7eb', flex: 5, wrap: true },
        { type: 'text', text: p.qty + ' ขวด', size: 'sm', color: ri.color, align: 'end', flex: 2, weight: 'bold' },
        { type: 'text', text: '฿' + Math.round(p.rev).toLocaleString(), size: 'sm', color: '#10b981', align: 'end', flex: 3, weight: 'bold' }
      ], margin: 'md'
    };
  });

  const netMargin = today.revenue > 0 ? (today.profit / today.revenue) * 100 : 0;
  const marginColor = netMargin >= 30 ? '#10b981' : netMargin >= 15 ? '#3b82f6' : netMargin >= 0 ? '#f59e0b' : '#ef4444';

  return {
    type: 'flex',
    altText: 'รายงานประจำวัน ' + formatThaiDateShort(d),
    contents: {
      type: 'bubble', size: 'giga',
      header: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'text', text: '🌙 รายงานประจำวัน', weight: 'bold', color: '#10b981', size: 'lg' },
          { type: 'text', text: formatThaiDate(d), color: '#9ca3af', size: 'xs', margin: 'sm' }
        ],
        backgroundColor: '#0a0c10', paddingAll: '16px'
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '💰 รายได้รวม', color: '#9ca3af', size: 'xs' },
            { type: 'text', text: '฿' + Math.round(today.revenue).toLocaleString(), color: '#10b981', size: 'xxl', weight: 'bold', margin: 'xs' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm', contents: [
              { type: 'text', text: '📦 ' + today.volume + ' ขวด', color: '#3b82f6', size: 'xs', flex: 1 },
              { type: 'text', text: '🧾 ' + today.txCount + ' บิล', color: '#8b5cf6', size: 'xs', align: 'end', flex: 1 }
            ]}
          ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'เทียบกับเมื่อวาน', color: '#9ca3af', size: 'xs', flex: 3 },
            { type: 'text', text: growthEmoji + ' ' + growthText, color: growthColor, size: 'sm', weight: 'bold', align: 'end', flex: 2 }
          ], margin: 'sm', paddingAll: '8px', backgroundColor: '#0a0c10', cornerRadius: '8px' },
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '📋 สินค้าแต่ละตัว', weight: 'bold', color: '#ffffff', size: 'sm', margin: 'md' },
          ...(productRows.length > 0 ? productRows : [{ type: 'text', text: 'ไม่มีรายการขายในวันนี้', color: '#6b7280', size: 'xs', margin: 'md', align: 'center' }]),
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '💵 สรุปการเงิน', weight: 'bold', color: '#ffffff', size: 'sm', margin: 'md' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'รายได้', color: '#9ca3af', size: 'sm', flex: 3 },
            { type: 'text', text: '฿' + Math.round(today.revenue).toLocaleString(), color: '#10b981', size: 'sm', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'รายจ่าย', color: '#9ca3af', size: 'sm', flex: 3 },
            { type: 'text', text: '฿' + Math.round(today.expenses).toLocaleString(), color: '#ef4444', size: 'sm', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'กำไรสุทธิ', color: '#ffffff', size: 'sm', flex: 3, weight: 'bold' },
            { type: 'text', text: '฿' + Math.round(today.profit).toLocaleString(), color: today.profit >= 0 ? '#f59e0b' : '#ef4444', size: 'md', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'อัตรากำไร', color: '#9ca3af', size: 'xs', flex: 3 },
            { type: 'text', text: netMargin.toFixed(1) + '%', color: marginColor, size: 'sm', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' },
          { type: 'separator', margin: 'lg' },
          { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'md', contents: [
            { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '📅 รายงานสัปดาห์', size: 'xs', color: '#3b82f6', align: 'center', weight: 'bold' }], backgroundColor: '#0f1419', paddingAll: '8px', cornerRadius: '8px', flex: 1, action: { type: 'message', text: 'รายงานสัปดาห์' } },
            { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '📆 รายงานเดือน', size: 'xs', color: '#f59e0b', align: 'center', weight: 'bold' }], backgroundColor: '#0f1419', paddingAll: '8px', cornerRadius: '8px', flex: 1, action: { type: 'message', text: 'รายงานเดือน' } }
          ]}
        ],
        paddingAll: '16px'
      },
      styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
    }
  };
}

function replyDailyReport(replyToken) {
  try { replyFlex(replyToken, buildDailyReportFlex(new Date())); }
  catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

// ============================================================================
// 📊 BEAUTIFUL REPORT — WEEKLY
// ============================================================================
function buildWeeklyReportFlex(targetDate) {
  const data = getAllData();
  const now = targetDate ? new Date(targetDate) : new Date();
  const weekEnd = new Date(now); weekEnd.setHours(23, 59, 59, 999);
  const weekStart = new Date(weekEnd.getTime() - 7 * 86400000 + 1); weekStart.setHours(0, 0, 0, 0);
  const prevEnd = new Date(weekStart.getTime());
  const prevStart = new Date(prevEnd.getTime() - 7 * 86400000);

  const week = calcStats(data.logs, data.expenses, weekStart, weekEnd);
  const prev = calcStats(data.logs, data.expenses, prevStart, prevEnd);

  const sales = (data.logs || []).filter(function(l) {
    if (l.type !== 'OUT') return false;
    const ld = new Date(l.timestamp);
    return ld >= weekStart && ld <= weekEnd;
  });

  const dayNames = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
  const dailyData = [];
  for (let i = 6; i >= 0; i--) {
    const ds = new Date(weekEnd.getTime() - i * 86400000); ds.setHours(0, 0, 0, 0);
    const de = new Date(ds.getTime() + 86400000);
    const daySales = sales.filter(function(l) { const d = new Date(l.timestamp); return d >= ds && d < de; });
    const dayRev = daySales.reduce(function(s, l) { return s + Number(l.total || 0); }, 0);
    const dayVol = daySales.reduce(function(s, l) { return s + Number(l.qty || 0); }, 0);
    dailyData.push({ dayName: dayNames[ds.getDay()], date: ds, revenue: dayRev, volume: dayVol });
  }
  const maxRev = Math.max.apply(null, dailyData.map(function(d) { return d.revenue; })) || 1;
  const dayRows = dailyData.map(function(d) {
    const barLen = Math.round((d.revenue / maxRev) * 15);
    const bar = '█'.repeat(Math.max(0, barLen)) + '░'.repeat(Math.max(0, 15 - barLen));
    return { type: 'box', layout: 'vertical', contents: [
      { type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: d.dayName + ' ' + d.date.getDate() + '/' + (d.date.getMonth() + 1), size: 'xs', color: '#9ca3af', flex: 3 },
        { type: 'text', text: '฿' + Math.round(d.revenue).toLocaleString(), size: 'xs', color: d.revenue === maxRev ? '#10b981' : '#ffffff', align: 'end', flex: 3, weight: 'bold' },
        { type: 'text', text: d.volume + ' ขวด', size: 'xxs', color: '#6b7280', align: 'end', flex: 2 }
      ]},
      { type: 'text', text: bar, size: 'xs', color: d.revenue === maxRev ? '#10b981' : '#3b82f6', margin: 'xs' }
    ], margin: 'md' };
  });

  const byProduct = {};
  sales.forEach(function(l) {
    const key = l.productName || 'ไม่ทราบ';
    if (!byProduct[key]) byProduct[key] = { qty: 0, rev: 0, rt: l.recipeType || '' };
    byProduct[key].qty += Number(l.qty || 0);
    byProduct[key].rev += Number(l.total || 0);
  });
  const sortedProducts = Object.keys(byProduct).sort(function(a, b) { return byProduct[b].qty - byProduct[a].qty; }).slice(0, 8);
  const productRows = sortedProducts.map(function(name) {
    const p = byProduct[name];
    const ri = p.rt === 'RED' ? { emoji: '🔴', color: '#ef4444' } :
               p.rt === 'BM' ? { emoji: '🟡', color: '#f59e0b' } :
               p.rt === 'ORIGINAL' ? { emoji: '⚪', color: '#9ca3af' } : { emoji: '📦', color: '#6b7280' };
    return { type: 'box', layout: 'horizontal', contents: [
      { type: 'text', text: ri.emoji + ' ' + (name.length > 22 ? name.substring(0, 22) + '...' : name), size: 'xs', color: '#e5e7eb', flex: 5, wrap: true },
      { type: 'text', text: p.qty + ' ขวด', size: 'xs', color: ri.color, align: 'end', flex: 2, weight: 'bold' },
      { type: 'text', text: '฿' + Math.round(p.rev).toLocaleString(), size: 'xs', color: '#10b981', align: 'end', flex: 3, weight: 'bold' }
    ], margin: 'sm' };
  });

  const growth = prev.revenue > 0 ? ((week.revenue - prev.revenue) / prev.revenue) * 100 : 0;
  const growthEmoji = growth >= 0 ? '📈' : '📉';
  const growthColor = growth >= 0 ? '#10b981' : '#ef4444';

  return {
    type: 'flex',
    altText: 'รายงานสัปดาห์ ' + formatThaiDateShort(weekStart) + ' - ' + formatThaiDateShort(weekEnd),
    contents: {
      type: 'bubble', size: 'giga',
      header: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'text', text: '📅 รายงานสัปดาห์', weight: 'bold', color: '#3b82f6', size: 'lg' },
          { type: 'text', text: formatThaiDateShort(weekStart) + ' - ' + formatThaiDateShort(weekEnd), color: '#9ca3af', size: 'xs', margin: 'sm' }
        ],
        backgroundColor: '#0a0c10', paddingAll: '16px'
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '💰 รายได้รวม 7 วัน', color: '#9ca3af', size: 'xs' },
            { type: 'text', text: '฿' + Math.round(week.revenue).toLocaleString(), color: '#10b981', size: 'xxl', weight: 'bold', margin: 'xs' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm', contents: [
              { type: 'text', text: '📦 ' + week.volume + ' ขวด', color: '#3b82f6', size: 'xs', flex: 1 },
              { type: 'text', text: '🧾 ' + week.txCount + ' บิล', color: '#8b5cf6', size: 'xs', align: 'end', flex: 1 }
            ]}
          ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'เทียบกับสัปดาห์ก่อน', color: '#9ca3af', size: 'xs', flex: 3 },
            { type: 'text', text: growthEmoji + ' ' + (growth >= 0 ? '+' : '') + growth.toFixed(1) + '%', color: growthColor, size: 'sm', weight: 'bold', align: 'end', flex: 2 }
          ], margin: 'sm', paddingAll: '8px', backgroundColor: '#0a0c10', cornerRadius: '8px' },
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '📊 ยอดขายรายวัน', weight: 'bold', color: '#ffffff', size: 'sm', margin: 'md' },
          ...dayRows,
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '🏆 สินค้าขายดี Top ' + Math.min(8, sortedProducts.length), weight: 'bold', color: '#ffffff', size: 'sm', margin: 'md' },
          ...(productRows.length > 0 ? productRows : [{ type: 'text', text: 'ไม่มีรายการขาย', color: '#6b7280', size: 'xs', margin: 'md', align: 'center' }]),
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '💵 สรุปการเงิน', weight: 'bold', color: '#ffffff', size: 'sm', margin: 'md' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'รายได้', color: '#9ca3af', size: 'sm', flex: 3 },
            { type: 'text', text: '฿' + Math.round(week.revenue).toLocaleString(), color: '#10b981', size: 'sm', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'รายจ่าย', color: '#9ca3af', size: 'sm', flex: 3 },
            { type: 'text', text: '฿' + Math.round(week.expenses).toLocaleString(), color: '#ef4444', size: 'sm', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'กำไรสุทธิ', color: '#ffffff', size: 'sm', flex: 3, weight: 'bold' },
            { type: 'text', text: '฿' + Math.round(week.profit).toLocaleString(), color: week.profit >= 0 ? '#f59e0b' : '#ef4444', size: 'md', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' }
        ],
        paddingAll: '16px'
      },
      styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
    }
  };
}

function replyWeeklyReport(replyToken) {
  try { replyFlex(replyToken, buildWeeklyReportFlex(new Date())); }
  catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

// ============================================================================
// 📊 BEAUTIFUL REPORT — MONTHLY
// ============================================================================
function buildMonthlyReportFlex(targetDate) {
  const data = getAllData();
  const now = targetDate ? new Date(targetDate) : new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

  const month = calcStats(data.logs, data.expenses, monthStart, monthEnd);
  const prev = calcStats(data.logs, data.expenses, prevStart, prevEnd);

  const sales = (data.logs || []).filter(function(l) {
    if (l.type !== 'OUT') return false;
    const ld = new Date(l.timestamp);
    return ld >= monthStart && ld <= monthEnd;
  });

  const byProduct = {};
  sales.forEach(function(l) {
    const key = l.productName || 'ไม่ทราบ';
    if (!byProduct[key]) byProduct[key] = { qty: 0, rev: 0, rt: l.recipeType || '' };
    byProduct[key].qty += Number(l.qty || 0);
    byProduct[key].rev += Number(l.total || 0);
  });
  const sortedProducts = Object.keys(byProduct).sort(function(a, b) { return byProduct[b].rev - byProduct[a].rev; }).slice(0, 10);
  const productRows = sortedProducts.map(function(name, idx) {
    const p = byProduct[name];
    const rankEmoji = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '#' + (idx + 1);
    const ri = p.rt === 'RED' ? { emoji: '🔴', color: '#ef4444' } :
               p.rt === 'BM' ? { emoji: '🟡', color: '#f59e0b' } :
               p.rt === 'ORIGINAL' ? { emoji: '⚪', color: '#9ca3af' } : { emoji: '📦', color: '#6b7280' };
    return { type: 'box', layout: 'horizontal', contents: [
      { type: 'text', text: rankEmoji + ' ' + ri.emoji, size: 'sm', color: '#e5e7eb', flex: 1 },
      { type: 'text', text: name.length > 18 ? name.substring(0, 18) + '...' : name, size: 'xs', color: '#e5e7eb', flex: 4, wrap: true },
      { type: 'text', text: p.qty + ' ขวด', size: 'xs', color: ri.color, align: 'end', flex: 2, weight: 'bold' },
      { type: 'text', text: '฿' + Math.round(p.rev).toLocaleString(), size: 'xs', color: '#10b981', align: 'end', flex: 3, weight: 'bold' }
    ], margin: 'sm' };
  });

  const growth = prev.revenue > 0 ? ((month.revenue - prev.revenue) / prev.revenue) * 100 : 0;
  const growthEmoji = growth >= 0 ? '📈' : '📉';
  const growthColor = growth >= 0 ? '#10b981' : '#ef4444';
  const netMargin = month.revenue > 0 ? (month.profit / month.revenue) * 100 : 0;
  const monthName = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'][now.getMonth()];

  return {
    type: 'flex',
    altText: 'รายงานเดือน ' + monthName + ' ' + (now.getFullYear() + 543),
    contents: {
      type: 'bubble', size: 'giga',
      header: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'text', text: '📆 รายงานประจำเดือน', weight: 'bold', color: '#f59e0b', size: 'lg' },
          { type: 'text', text: monthName + ' ' + (now.getFullYear() + 543), color: '#9ca3af', size: 'xs', margin: 'sm' }
        ],
        backgroundColor: '#0a0c10', paddingAll: '16px'
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '💰 รายได้รวมทั้งเดือน', color: '#9ca3af', size: 'xs' },
            { type: 'text', text: '฿' + Math.round(month.revenue).toLocaleString(), color: '#10b981', size: 'xxl', weight: 'bold', margin: 'xs' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm', contents: [
              { type: 'text', text: '📦 ' + month.volume + ' ขวด', color: '#3b82f6', size: 'xs', flex: 1 },
              { type: 'text', text: '🧾 ' + month.txCount + ' บิล', color: '#8b5cf6', size: 'xs', align: 'end', flex: 1 }
            ]}
          ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'เทียบกับเดือนก่อน', color: '#9ca3af', size: 'xs', flex: 3 },
            { type: 'text', text: growthEmoji + ' ' + (growth >= 0 ? '+' : '') + growth.toFixed(1) + '%', color: growthColor, size: 'sm', weight: 'bold', align: 'end', flex: 2 }
          ], margin: 'sm', paddingAll: '8px', backgroundColor: '#0a0c10', cornerRadius: '8px' },
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '🏆 สินค้าขายดี Top ' + sortedProducts.length, weight: 'bold', color: '#ffffff', size: 'sm', margin: 'md' },
          ...(productRows.length > 0 ? productRows : [{ type: 'text', text: 'ไม่มีรายการขายในเดือนนี้', color: '#6b7280', size: 'xs', margin: 'md', align: 'center' }]),
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '💵 สรุปการเงิน', weight: 'bold', color: '#ffffff', size: 'sm', margin: 'md' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'รายได้', color: '#9ca3af', size: 'sm', flex: 3 },
            { type: 'text', text: '฿' + Math.round(month.revenue).toLocaleString(), color: '#10b981', size: 'sm', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'รายจ่าย', color: '#9ca3af', size: 'sm', flex: 3 },
            { type: 'text', text: '฿' + Math.round(month.expenses).toLocaleString(), color: '#ef4444', size: 'sm', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'กำไรสุทธิ', color: '#ffffff', size: 'sm', flex: 3, weight: 'bold' },
            { type: 'text', text: '฿' + Math.round(month.profit).toLocaleString(), color: month.profit >= 0 ? '#f59e0b' : '#ef4444', size: 'md', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'อัตรากำไร', color: '#9ca3af', size: 'xs', flex: 3 },
            { type: 'text', text: netMargin.toFixed(1) + '%', color: netMargin >= 20 ? '#10b981' : netMargin >= 0 ? '#f59e0b' : '#ef4444', size: 'sm', weight: 'bold', align: 'end', flex: 4 }
          ], margin: 'sm' }
        ],
        paddingAll: '16px'
      },
      styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
    }
  };
}

function replyMonthlyReport(replyToken) {
  try { replyFlex(replyToken, buildMonthlyReportFlex(new Date())); }
  catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

console.log('🍃 KRATOM POS v' + CONFIG.VERSION + ' — Part 2 loaded (LINE, Quota, Summary, Reports)');
// ============================================================================
// 📌 replyDashboard
// ============================================================================
function replyDashboard(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const todayStats = calcStats(data.logs, data.expenses, new Date(now.getFullYear(), now.getMonth(), now.getDate()), now);
    const weekStats = calcStats(data.logs, data.expenses, new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthStats = calcStats(data.logs, data.expenses, monthStart, now);
    const lastMonthStats = calcStats(data.logs, data.expenses, new Date(now.getFullYear(), now.getMonth() - 1, 1), monthStart);
    const monthGrowth = lastMonthStats.revenue > 0 ? ((monthStats.revenue - lastMonthStats.revenue) / lastMonthStats.revenue) * 100 : 0;
    const growthEmoji = monthGrowth >= 0 ? '📈' : '📉';
    const growthColor = monthGrowth >= 0 ? '#10b981' : '#ef4444';

    const products = data.products || [];
    let totalStock = 0, lowStockCount = 0;
    products.forEach(p => {
      const stock = calculateStockForProduct(p);
      totalStock += Math.max(0, stock);
      if (stock <= 5) lowStockCount++;
    });

    const flexMessage = {
      type: 'flex',
      altText: 'Dashboard ภาพรวม',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '📊 DASHBOARD', weight: 'bold', color: '#10b981', size: 'xl' },
            { type: 'text', text: formatThaiDate(new Date()), color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '20px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'lg',
          contents: [
            createSectionTitle('🌅 วันนี้', '#10b981'),
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('💰 รายได้', '฿' + todayStats.revenue.toLocaleString(), '#10b981'), createStatBox('📦 ขวด', String(todayStats.volume), '#3b82f6')] },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('🧾 บิล', String(todayStats.txCount), '#8b5cf6'), createStatBox('💵 กำไร', '฿' + todayStats.profit.toLocaleString(), todayStats.profit >= 0 ? '#f59e0b' : '#ef4444')], margin: 'sm' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📅 สัปดาห์นี้ (7 วัน)', '#3b82f6'),
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('💰 รายได้', '฿' + weekStats.revenue.toLocaleString(), '#10b981'), createStatBox('📦 ขวด', String(weekStats.volume), '#3b82f6')] },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('📊 เฉลี่ย/วัน', '฿' + Math.round(weekStats.revenue / 7).toLocaleString(), '#8b5cf6'), createStatBox('💵 กำไร', '฿' + weekStats.profit.toLocaleString(), weekStats.profit >= 0 ? '#f59e0b' : '#ef4444')], margin: 'sm' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📆 เดือนนี้', '#f59e0b'),
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('💰 รายได้', '฿' + monthStats.revenue.toLocaleString(), '#10b981'), createStatBox('📦 ขวด', String(monthStats.volume), '#3b82f6')] },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('📈 เติบโต', growthEmoji + ' ' + (monthGrowth >= 0 ? '+' : '') + monthGrowth.toFixed(1) + '%', growthColor), createStatBox('💵 กำไรสุทธิ', '฿' + monthStats.profit.toLocaleString(), monthStats.profit >= 0 ? '#f59e0b' : '#ef4444')], margin: 'sm' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📦 สต๊อก (StockBalance)', '#8b5cf6'),
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('รวมทั้งหมด', totalStock + ' ขวด', '#3b82f6'), createStatBox('ต่ำกว่าเกณฑ์', lowStockCount + ' รายการ', lowStockCount > 0 ? '#ef4444' : '#10b981')] },
            { type: 'separator', margin: 'lg' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createQuickButton('สรุป', '#10b981'), createQuickButton('รายงานวันนี้', '#3b82f6'), createQuickButton('รายงานเดือน', '#f59e0b')], margin: 'md' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

// ============================================================================
// 📌 replyStockReport — ใช้ StockBalance
// ============================================================================
function replyStockReport(replyToken) {
  try {
    const products = getProducts().products || [];
    const stockMap = readStockBalance();
    const stockRows = products.map(p => {
      const stock = stockMap[p.id] !== undefined ? stockMap[p.id] : (stockMap['name:' + p.name] || 0);
      const stockColor = stock <= 5 ? '#ef4444' : stock <= 15 ? '#f59e0b' : '#10b981';
      const stockEmoji = stock <= 5 ? '🔴' : stock <= 15 ? '🟡' : '🟢';
      const emoji = p.recipeType === 'RED' ? '🔴' : p.recipeType === 'BM' ? '🟡' : '⚪';
      return {
        type: 'box', layout: 'horizontal',
        contents: [
          { type: 'text', text: emoji + ' ' + p.name, size: 'xs', color: '#e5e7eb', flex: 6, wrap: true },
          { type: 'text', text: stockEmoji + ' ' + stock, size: 'sm', color: stockColor, align: 'end', flex: 2, weight: 'bold' }
        ], margin: 'md'
      };
    });

    let totalStock = 0, lowStockCount = 0;
    products.forEach(p => {
      const s = stockMap[p.id] !== undefined ? stockMap[p.id] : (stockMap['name:' + p.name] || 0);
      totalStock += Math.max(0, s);
      if (s <= 5) lowStockCount++;
    });

    const flexMessage = {
      type: 'flex',
      altText: 'รายงานสต๊อก',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '📦 รายงานสต๊อก', weight: 'bold', color: '#3b82f6', size: 'lg' },
            { type: 'text', text: formatThaiDate(new Date()), color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('รวมทั้งหมด', totalStock + ' ขวด', '#3b82f6'), createStatBox('ต่ำกว่าเกณฑ์', lowStockCount + ' รายการ', lowStockCount > 0 ? '#ef4444' : '#10b981')] },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('รายการสินค้า', '#3b82f6'),
            { type: 'box', layout: 'vertical', contents: stockRows.length > 0 ? stockRows : [{ type: 'text', text: 'ไม่มีสินค้า', color: '#6b7280', size: 'xs' }] },
            lowStockCount > 0
              ? { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '⚠️ มี ' + lowStockCount + ' รายการที่ต้องเติมสต๊อก', color: '#f59e0b', size: 'xs', weight: 'bold' }], backgroundColor: '#2a1f05', paddingAll: '10px', cornerRadius: '10px', margin: 'lg' }
              : { type: 'filler' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

// ============================================================================
// 📌 replyProductAnalysis
// ============================================================================
function replyProductAnalysis(replyToken) {
  try {
    const data = getAllData();
    const products = data.products || [];
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentSales = salesLogs.filter(l => new Date(l.timestamp) >= thirtyDaysAgo);

    const totalRev = recentSales.reduce((s, l) => s + Number(l.total || 0), 0);
    const totalVol = recentSales.reduce((s, l) => s + Number(l.qty || 0), 0);
    const stockMap = readStockBalance();

    const productStats = products.map(p => {
      const sales = recentSales.filter(l => l.productName === p.name);
      const revenue = sales.reduce((s, l) => s + Number(l.total || 0), 0);
      const volume = sales.reduce((s, l) => s + Number(l.qty || 0), 0);
      const unitCost = getUnitCostFromConfig(p.recipeType);
      const profit = revenue - (volume * unitCost);
      const profitMargin = revenue > 0 ? (profit / revenue) * 100 : 0;
      const volShare = totalVol > 0 ? (volume / totalVol) * 100 : 0;
      const stock = stockMap[p.id] !== undefined ? stockMap[p.id] : (stockMap['name:' + p.name] || 0);
      return { product: p, revenue, volume, profit, profitMargin, volShare, stock };
    }).sort((a, b) => b.revenue - a.revenue);

    const productCards = productStats.map((p, idx) => {
      const rt = p.product.recipeType;
      const emoji = rt === 'RED' ? '🔴' : rt === 'BM' ? '🟡' : rt === 'ORIGINAL' ? '⚪' : '📦';
      const rank = idx + 1;
      const rankEmoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '#' + rank;
      const profitColor = p.profit >= 0 ? '#10b981' : '#ef4444';
      const stockColor = p.stock <= 5 ? '#ef4444' : p.stock <= 15 ? '#f59e0b' : '#10b981';
      return {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: rankEmoji + ' ' + emoji, size: 'sm', color: '#ffffff', flex: 1 },
            { type: 'text', text: p.product.name, size: 'xs', color: '#ffffff', weight: 'bold', flex: 5, wrap: true },
            { type: 'text', text: p.volShare.toFixed(1) + '%', size: 'xs', color: '#f59e0b', align: 'end', flex: 2, weight: 'bold' }
          ]},
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'ขาย ' + p.volume + ' ขวด', size: 'xxs', color: '#9ca3af', flex: 3 },
            { type: 'text', text: '฿' + p.revenue.toLocaleString(), size: 'xs', color: '#10b981', align: 'end', flex: 3, weight: 'bold' }
          ], margin: 'xs' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'กำไร ฿' + Math.round(p.profit).toLocaleString() + ' (' + p.profitMargin.toFixed(0) + '%)', size: 'xxs', color: profitColor, flex: 5 },
            { type: 'text', text: 'สต๊อก ' + p.stock, size: 'xxs', color: stockColor, align: 'end', flex: 3 }
          ], margin: 'xs' }
        ],
        backgroundColor: '#0f1419', paddingAll: '10px', cornerRadius: '10px', margin: 'md'
      };
    });

    const flexMessage = {
      type: 'flex',
      altText: 'วิเคราะห์สินค้าทุกตัว',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '📊 วิเคราะห์สินค้าทุกตัว', weight: 'bold', color: '#10b981', size: 'lg' },
            { type: 'text', text: '30 วันล่าสุด · เรียงตามรายได้', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('รวมรายได้', '฿' + totalRev.toLocaleString(), '#10b981'), createStatBox('รวมขวด', String(totalVol), '#3b82f6')] },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('สินค้าทั้งหมด', String(products.length), '#8b5cf6'), createStatBox('ขายแล้ว', String(productStats.filter(p => p.volume > 0).length), '#f59e0b')] },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('🏆 อันดับสินค้า', '#f59e0b'),
            { type: 'box', layout: 'vertical', contents: productCards.length > 0 ? productCards : [{ type: 'text', text: 'ยังไม่มีข้อมูลการขาย', color: '#6b7280', size: 'sm' }] }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

// ============================================================================
// 📌 replyProductDetail
// ============================================================================
function replyProductDetail(replyToken, productName) {
  try {
    if (!productName) { replyText(replyToken, '❌ กรุณาระบุชื่อสินค้า\nตัวอย่าง: สินค้า น้ำกระท่อมฝาแดง'); return; }
    const data = getAllData();
    const product = (data.products || []).find(p => p.name.toLowerCase().includes(productName.toLowerCase()));
    if (!product) { replyText(replyToken, '❌ ไม่พบสินค้า "' + productName + '"\n\nลองพิมพ์ "วิเคราะห์สินค้า" เพื่อดูรายการทั้งหมด'); return; }

    const salesLogs = data.logs.filter(l => l.type === 'OUT' && l.productName === product.name);
    const now = new Date();
    const todaySales = salesLogs.filter(l => new Date(l.timestamp) >= new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    const weekSales = salesLogs.filter(l => new Date(l.timestamp) >= new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
    const monthSales = salesLogs.filter(l => new Date(l.timestamp) >= new Date(now.getFullYear(), now.getMonth(), 1));

    const calcSales = (logs) => ({ volume: logs.reduce((s, l) => s + Number(l.qty || 0), 0), revenue: logs.reduce((s, l) => s + Number(l.total || 0), 0), count: logs.length });
    const todayStats = calcSales(todaySales);
    const weekStats = calcSales(weekSales);
    const monthStats = calcSales(monthSales);
    const allStats = calcSales(salesLogs);

    const unitCost = getUnitCostFromConfig(product.recipeType);
    const unitPrice = product.price;
    const unitProfit = unitPrice - unitCost;
    const profitMargin = unitPrice > 0 ? (unitProfit / unitPrice) * 100 : 0;
    const monthProfit = monthStats.volume * unitProfit;
    const stockMap = readStockBalance();
    const stock = stockMap[product.id] !== undefined ? stockMap[product.id] : (stockMap['name:' + product.name] || 0);

    const flexMessage = {
      type: 'flex',
      altText: 'ข้อมูลสินค้า: ' + product.name,
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: product.recipeType === 'RED' ? '🔴' : product.recipeType === 'BM' ? '🟡' : '⚪', size: 'xxl' },
            { type: 'text', text: product.name, weight: 'bold', color: '#ffffff', size: 'md', wrap: true, margin: 'sm' },
            { type: 'text', text: 'ราคา ฿' + product.price + ' · สูตร ' + product.recipeType, color: '#9ca3af', size: 'xs', margin: 'xs' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '💰 ยอดขายรวมทั้งหมด', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: '฿' + allStats.revenue.toLocaleString(), color: '#10b981', size: 'xxl', weight: 'bold' },
              { type: 'text', text: 'ขายได้ ' + allStats.volume + ' ขวด (' + allStats.count + ' บิล)', color: '#3b82f6', size: 'sm', margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📅 สรุปรายช่วง', '#3b82f6'),
            createAnalysisRow('วันนี้', todayStats.volume + ' ขวด · ฿' + todayStats.revenue.toLocaleString(), '#10b981'),
            createAnalysisRow('7 วัน', weekStats.volume + ' ขวด · ฿' + weekStats.revenue.toLocaleString(), '#3b82f6'),
            createAnalysisRow('เดือนนี้', monthStats.volume + ' ขวด · ฿' + monthStats.revenue.toLocaleString(), '#f59e0b'),
            { type: 'separator', margin: 'lg' },
            createSectionTitle('💵 กำไร', '#10b981'),
            createAnalysisRow('ต้นทุน/ขวด', '฿' + unitCost.toFixed(2), '#ef4444'),
            createAnalysisRow('กำไร/ขวด', '฿' + unitProfit.toFixed(2) + ' (' + profitMargin.toFixed(1) + '%)', '#10b981'),
            createAnalysisRow('กำไรเดือนนี้', '฿' + monthProfit.toLocaleString(), monthProfit >= 0 ? '#10b981' : '#ef4444'),
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📦 สต๊อก (StockBalance)', stock <= 5 ? '#ef4444' : '#3b82f6'),
            createAnalysisRow('คงเหลือ', stock + ' ขวด', stock <= 5 ? '#ef4444' : stock <= 15 ? '#f59e0b' : '#10b981'),
            createAnalysisRow('สถานะ', stock <= 5 ? '⚠️ ต้องเติม' : stock <= 15 ? '🟡 ปานกลาง' : '✅ เพียงพอ', stock <= 5 ? '#ef4444' : stock <= 15 ? '#f59e0b' : '#10b981'),
            createAnalysisRow('ขายได้อีก', (stock > 0 ? Math.floor(stock / Math.max(1, monthStats.volume / 30)) : 0) + ' วัน', '#8b5cf6')
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

// ============================================================================
// 📌 replyMarketShare, replyKPIDashboard, replyKPITarget, replySetTarget
// ============================================================================
function replyMarketShare(replyToken) {
  try {
    const data = getAllData();
    const products = data.products || [];
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentSales = salesLogs.filter(l => new Date(l.timestamp) >= thirtyDaysAgo);
    const totalRev = recentSales.reduce((s, l) => s + Number(l.total || 0), 0);
    const totalVol = recentSales.reduce((s, l) => s + Number(l.qty || 0), 0);

    const productStats = products.map(p => {
      const sales = recentSales.filter(l => l.productName === p.name);
      const revenue = sales.reduce((s, l) => s + Number(l.total || 0), 0);
      const volume = sales.reduce((s, l) => s + Number(l.qty || 0), 0);
      return { product: p, revenue, volume, volShare: totalVol > 0 ? (volume / totalVol) * 100 : 0, revShare: totalRev > 0 ? (revenue / totalRev) * 100 : 0 };
    }).sort((a, b) => b.revShare - a.revShare);

    const shareRows = productStats.map(p => {
      const barLen = Math.round((p.revShare / 100) * 20);
      const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
      const color = p.revShare > 40 ? '#10b981' : p.revShare > 20 ? '#3b82f6' : '#f59e0b';
      return { type: 'box', layout: 'vertical', contents: [
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: p.product.name, size: 'xs', color: '#ffffff', flex: 6, wrap: true },
          { type: 'text', text: p.revShare.toFixed(1) + '%', size: 'sm', color: color, align: 'end', flex: 2, weight: 'bold' }
        ]},
        { type: 'text', text: bar, size: 'xs', color: color, margin: 'xs' },
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: 'ปริมาณ ' + p.volShare.toFixed(1) + '%', size: 'xxs', color: '#9ca3af', flex: 3 },
          { type: 'text', text: '฿' + p.revenue.toLocaleString(), size: 'xxs', color: '#10b981', align: 'end', flex: 3 }
        ], margin: 'xs' }
      ], margin: 'lg' };
    });

    const redRev = productStats.filter(p => p.product.recipeType === 'RED').reduce((s, p) => s + p.revenue, 0);
    const bmRev = productStats.filter(p => p.product.recipeType === 'BM').reduce((s, p) => s + p.revenue, 0);
    const origRev = productStats.filter(p => p.product.recipeType === 'ORIGINAL').reduce((s, p) => s + p.revenue, 0);
    const redShare = totalRev > 0 ? (redRev / totalRev) * 100 : 0;
    const bmShare = totalRev > 0 ? (bmRev / totalRev) * 100 : 0;
    const origShare = totalRev > 0 ? (origRev / totalRev) * 100 : 0;

    const flexMessage = {
      type: 'flex',
      altText: 'สัดส่วนตลาด',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '📊 ส่วนแบ่งตลาด', weight: 'bold', color: '#8b5cf6', size: 'lg' },
            { type: 'text', text: '30 วันล่าสุด · Market Share', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '🔴 ฝาแดง · 🟡 BM · ⚪ Original', color: '#9ca3af', size: 'xs' },
              { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
                createStatBox('🔴', redShare.toFixed(1) + '%', '#ef4444'),
                createStatBox('🟡', bmShare.toFixed(1) + '%', '#f59e0b'),
                createStatBox('⚪', origShare.toFixed(1) + '%', '#9ca3af')
              ], margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('🏆 อันดับตามส่วนแบ่งรายได้', '#8b5cf6'),
            { type: 'box', layout: 'vertical', contents: shareRows.length > 0 ? shareRows : [{ type: 'text', text: 'ยังไม่มีข้อมูล', color: '#6b7280', size: 'sm' }] },
            { type: 'separator', margin: 'lg' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('รายได้รวม', '฿' + totalRev.toLocaleString(), '#10b981'),
              createStatBox('ปริมาณรวม', String(totalVol), '#3b82f6')
            ]}
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

function replyKPIDashboard(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const thisMonth = calcStats(data.logs, data.expenses, monthStart, now);
    const lastMonth = calcStats(data.logs, data.expenses, lastMonthStart, monthStart);
    const config = readConfigAsObject(SpreadsheetApp.getActiveSpreadsheet());
    const targetRevenue = Number(config.kpiTargetRevenue) || 50000;
    const targetVolume = Number(config.kpiTargetVolume) || 1500;
    const targetProfit = Number(config.kpiTargetProfit) || 15000;
    const revProgress = targetRevenue > 0 ? (thisMonth.revenue / targetRevenue) * 100 : 0;
    const volProgress = targetVolume > 0 ? (thisMonth.volume / targetVolume) * 100 : 0;
    const profitProgress = targetProfit > 0 ? (thisMonth.profit / targetProfit) * 100 : 0;
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysLeft = daysInMonth - now.getDate() + 1;
    const projRev = thisMonth.revenue / now.getDate() * daysInMonth;
    const projVol = thisMonth.volume / now.getDate() * daysInMonth;
    const projProfit = thisMonth.profit / now.getDate() * daysInMonth;
    const revGrowth = lastMonth.revenue > 0 ? ((thisMonth.revenue - lastMonth.revenue) / lastMonth.revenue) * 100 : 0;
    const volGrowth = lastMonth.volume > 0 ? ((thisMonth.volume - lastMonth.volume) / lastMonth.volume) * 100 : 0;
    const profitGrowth = lastMonth.profit !== 0 ? ((thisMonth.profit - lastMonth.profit) / Math.abs(lastMonth.profit)) * 100 : 0;

    const createKPIBox = (icon, label, current, target, progress, projection, growth, unit) => {
      unit = unit || '';
      const prog = Math.min(100, progress);
      const barLen = Math.round(prog / 5);
      const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
      const progColor = progress >= 100 ? '#10b981' : progress >= 75 ? '#3b82f6' : progress >= 50 ? '#f59e0b' : '#ef4444';
      const growthEmoji = growth >= 0 ? '📈' : '📉';
      const growthColor = growth >= 0 ? '#10b981' : '#ef4444';
      return {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: icon + ' ' + label, size: 'sm', color: '#ffffff', weight: 'bold', flex: 4 },
            { type: 'text', text: progress.toFixed(0) + '%', size: 'sm', color: progColor, align: 'end', flex: 2, weight: 'bold' }
          ]},
          { type: 'text', text: bar, size: 'xs', color: progColor, margin: 'xs' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'ปัจจุบัน: ' + unit + current.toLocaleString(), size: 'xxs', color: '#9ca3af', flex: 4 },
            { type: 'text', text: 'เป้า: ' + unit + target.toLocaleString(), size: 'xxs', color: '#6b7280', align: 'end', flex: 4 }
          ], margin: 'xs' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'คาดการณ์: ' + unit + Math.round(projection).toLocaleString(), size: 'xxs', color: '#3b82f6', flex: 4 },
            { type: 'text', text: growthEmoji + ' ' + (growth >= 0 ? '+' : '') + growth.toFixed(1) + '%', size: 'xxs', color: growthColor, align: 'end', flex: 4 }
          ], margin: 'xs' }
        ],
        backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px', margin: 'md'
      };
    };

    const flexMessage = {
      type: 'flex',
      altText: 'KPI Dashboard',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '🎯 KPI DASHBOARD', weight: 'bold', color: '#8b5cf6', size: 'xl' },
            { type: 'text', text: 'เดือนนี้ · เหลือ ' + daysLeft + ' วัน', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            createKPIBox('💰', 'รายได้', thisMonth.revenue, targetRevenue, revProgress, projRev, revGrowth, '฿'),
            createKPIBox('📦', 'ปริมาณขาย', thisMonth.volume, targetVolume, volProgress, projVol, volGrowth, ''),
            createKPIBox('💵', 'กำไรสุทธิ', thisMonth.profit, targetProfit, profitProgress, projProfit, profitGrowth, '฿'),
            { type: 'separator', margin: 'lg' },
            { type: 'text', text: '⚙️ ตั้งเป้าหมายใหม่', size: 'sm', color: '#9ca3af', margin: 'md' },
            { type: 'text', text: 'พิมพ์: ตั้งเป้า รายได้ 50000\nตั้งเป้า ปริมาณ 1500\nตั้งเป้า กำไร 15000', size: 'xs', color: '#6b7280', wrap: true, margin: 'sm' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

function replyKPITarget(replyToken) {
  try {
    const config = readConfigAsObject(SpreadsheetApp.getActiveSpreadsheet());
    const targets = {
      revenue: Number(config.kpiTargetRevenue) || 50000,
      volume: Number(config.kpiTargetVolume) || 1500,
      profit: Number(config.kpiTargetProfit) || 15000
    };
    const flexMessage = {
      type: 'flex',
      altText: 'เป้าหมาย KPI',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [{ type: 'text', text: '🎯 เป้าหมาย KPI', weight: 'bold', color: '#f59e0b', size: 'lg' }],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '💰 เป้ารายได้/เดือน', color: '#9ca3af', size: 'xs' }, { type: 'text', text: '฿' + targets.revenue.toLocaleString(), color: '#10b981', size: 'xxl', weight: 'bold' }], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '📦 เป้าปริมาณ/เดือน', color: '#9ca3af', size: 'xs' }, { type: 'text', text: targets.volume.toLocaleString() + ' ขวด', color: '#3b82f6', size: 'xxl', weight: 'bold' }], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '💵 เป้ากำไร/เดือน', color: '#9ca3af', size: 'xs' }, { type: 'text', text: '฿' + targets.profit.toLocaleString(), color: '#f59e0b', size: 'xxl', weight: 'bold' }], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            { type: 'text', text: '⚙️ ตั้งเป้าใหม่:', size: 'xs', color: '#9ca3af', margin: 'md' },
            { type: 'text', text: 'ตั้งเป้า รายได้ 100000', size: 'xs', color: '#10b981', margin: 'sm', weight: 'bold' },
            { type: 'text', text: 'ตั้งเป้า ปริมาณ 3000', size: 'xs', color: '#3b82f6', margin: 'xs', weight: 'bold' },
            { type: 'text', text: 'ตั้งเป้า กำไร 30000', size: 'xs', color: '#f59e0b', margin: 'xs', weight: 'bold' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

function replySetTarget(replyToken, key, value) {
  try {
    const keyMap = {
      'รายได้': 'kpiTargetRevenue', 'revenue': 'kpiTargetRevenue',
      'ปริมาณ': 'kpiTargetVolume', 'volume': 'kpiTargetVolume',
      'กำไร': 'kpiTargetProfit', 'profit': 'kpiTargetProfit'
    };
    const configKey = keyMap[key];
    if (!configKey) { replyText(replyToken, '❌ ไม่รู้จักประเภทเป้าหมาย\n\nใช้: รายได้, ปริมาณ, กำไร'); return; }
    const numValue = Number(value);
    if (isNaN(numValue) || numValue <= 0) { replyText(replyToken, '❌ ค่าต้องเป็นตัวเลขมากกว่า 0'); return; }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.CONFIG);
    const data = sheet.getDataRange().getValues();
    let updated = false;
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === configKey) {
        sheet.getRange(i + 1, 2).setValue(numValue);
        sheet.getRange(i + 1, 3).setValue(new Date().toISOString());
        updated = true;
        break;
      }
    }
    if (!updated) sheet.appendRow([configKey, numValue, new Date().toISOString()]);
    invalidateCache();
    const labels = { kpiTargetRevenue: '💰 รายได้', kpiTargetVolume: '📦 ปริมาณ', kpiTargetProfit: '💵 กำไร' };
    replyText(replyToken, '✅ ตั้งเป้าใหม่สำเร็จ!\n\n' + labels[configKey] + ': ' + numValue.toLocaleString() + '\n\nพิมพ์ "kpi" เพื่อดูความคืบหน้า');
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

// ============================================================================
// 📌 replyTrendAnalysis, replyComparison, replyForecast, replyFullAnalysis
// ============================================================================
function replyTrendAnalysis(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const dailyData = [];
    for (let i = 29; i >= 0; i--) {
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      const stats = calcStats(data.logs, data.expenses, dayStart, dayEnd);
      dailyData.push({ date: dayStart, revenue: stats.revenue, volume: stats.volume, profit: stats.profit });
    }
    const n = dailyData.length;
    const xValues = dailyData.map((_, i) => i);
    const yValues = dailyData.map(d => d.revenue);
    const sumX = xValues.reduce((a, b) => a + b, 0);
    const sumY = yValues.reduce((a, b) => a + b, 0);
    const sumXY = xValues.reduce((sum, x, i) => sum + x * yValues[i], 0);
    const sumX2 = xValues.reduce((sum, x) => sum + x * x, 0);
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const avgRev = sumY / n;
    const trendPct = avgRev > 0 ? (slope / avgRev) * 100 : 0;
    const variance = yValues.reduce((sum, y) => sum + Math.pow(y - avgRev, 2), 0) / n;
    const stdDev = Math.sqrt(variance);
    const cv = avgRev > 0 ? (stdDev / avgRev) * 100 : 0;
    let trendText, trendEmoji, trendColor;
    if (slope > avgRev * 0.05) { trendText = 'เพิ่มขึ้นชัดเจน'; trendEmoji = '📈'; trendColor = '#10b981'; }
    else if (slope > 0) { trendText = 'เพิ่มขึ้นเล็กน้อย'; trendEmoji = '↗️'; trendColor = '#3b82f6'; }
    else if (slope < -avgRev * 0.05) { trendText = 'ลดลงชัดเจน'; trendEmoji = '📉'; trendColor = '#ef4444'; }
    else if (slope < 0) { trendText = 'ลดลงเล็กน้อย'; trendEmoji = '↘️'; trendColor = '#f59e0b'; }
    else { trendText = 'ค่อนข้างคงที่'; trendEmoji = '➡️'; trendColor = '#6b7280'; }
    let volText, volColor;
    if (cv < 20) { volText = 'ต่ำ (เสถียร)'; volColor = '#10b981'; }
    else if (cv < 50) { volText = 'ปานกลาง'; volColor = '#f59e0b'; }
    else { volText = 'สูง (ผันผวน)'; volColor = '#ef4444'; }
    const last7Days = dailyData.slice(-7).reduce((s, d) => s + d.revenue, 0);
    const prev7Days = dailyData.slice(-14, -7).reduce((s, d) => s + d.revenue, 0);
    const weeklyGrowth = prev7Days > 0 ? ((last7Days - prev7Days) / prev7Days) * 100 : 0;
    const sparkData = dailyData.slice(-14);
    const maxSpark = Math.max(...sparkData.map(d => d.revenue)) || 1;
    const sparkLevels = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const sparkline = sparkData.map(d => {
      const level = Math.min(7, Math.floor((d.revenue / maxSpark) * 8));
      return sparkLevels[level];
    }).join('');
    const flexMessage = {
      type: 'flex',
      altText: 'Trend Analysis',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '📈 TREND ANALYSIS', weight: 'bold', color: '#3b82f6', size: 'xl' },
            { type: 'text', text: '30 วันล่าสุด · วิเคราะห์แนวโน้ม', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '🎯 ทิศทางหลัก', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: trendEmoji + ' ' + trendText, color: trendColor, size: 'xl', weight: 'bold' },
              { type: 'text', text: (trendPct >= 0 ? '+' : '') + trendPct.toFixed(2) + '% ต่อวัน', color: trendColor, size: 'sm', margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '📊 แนวโน้ม 14 วันล่าสุด', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: sparkline, size: 'xxl', color: '#10b981', margin: 'sm', align: 'center' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px', margin: 'md' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📅 เปรียบเทียบรายสัปดาห์', '#3b82f6'),
            createAnalysisRow('7 วันล่าสุด', '฿' + last7Days.toLocaleString(), '#10b981'),
            createAnalysisRow('7 วันก่อนหน้า', '฿' + prev7Days.toLocaleString(), '#6b7280'),
            createAnalysisRow('การเปลี่ยนแปลง', (weeklyGrowth >= 0 ? '📈 +' : '📉 ') + weeklyGrowth.toFixed(1) + '%', weeklyGrowth >= 0 ? '#10b981' : '#ef4444'),
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📊 สถิติเชิงลึก', '#8b5cf6'),
            createAnalysisRow('เฉลี่ย/วัน', '฿' + Math.round(avgRev).toLocaleString(), '#10b981'),
            createAnalysisRow('ส่วนเบี่ยงเบน', '฿' + Math.round(stdDev).toLocaleString(), '#8b5cf6'),
            createAnalysisRow('ความผันผวน', volText, volColor),
            createAnalysisRow('ค่าสัมประสิทธิ์', cv.toFixed(1) + '%', volColor)
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

function replyComparison(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const todayStats = calcStats(data.logs, data.expenses, new Date(now.getFullYear(), now.getMonth(), now.getDate()), now);
    const weekStats = calcStats(data.logs, data.expenses, new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), now);
    const monthStats = calcStats(data.logs, data.expenses, new Date(now.getFullYear(), now.getMonth(), 1), now);
    const lastMonthStats = calcStats(data.logs, data.expenses, new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1));
    const prevWeekStats = calcStats(data.logs, data.expenses, new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000), new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
    const yesterdayStats = calcStats(data.logs, data.expenses, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1), new Date(now.getFullYear(), now.getMonth(), now.getDate()));

    const createComparisonRow = (label, current, previous, unit) => {
      unit = unit || '฿';
      const change = previous > 0 ? ((current - previous) / previous) * 100 : (current > 0 ? 100 : 0);
      const emoji = change > 5 ? '📈' : change < -5 ? '📉' : '➡️';
      const color = change > 5 ? '#10b981' : change < -5 ? '#ef4444' : '#f59e0b';
      return {
        type: 'box', layout: 'horizontal',
        contents: [
          { type: 'text', text: label, size: 'xs', color: '#9ca3af', flex: 4 },
          { type: 'text', text: unit + current.toLocaleString(), size: 'xs', color: '#ffffff', align: 'end', flex: 3, weight: 'bold' },
          { type: 'text', text: emoji + (change >= 0 ? '+' : '') + change.toFixed(0) + '%', size: 'xs', color: color, align: 'end', flex: 3, weight: 'bold' }
        ], margin: 'sm'
      };
    };

    const flexMessage = {
      type: 'flex',
      altText: 'เปรียบเทียบช่วงเวลา',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [{ type: 'text', text: '⚖️ เปรียบเทียบช่วงเวลา', weight: 'bold', color: '#8b5cf6', size: 'lg' }],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            createSectionTitle('📆 เดือนนี้ vs เดือนที่แล้ว', '#f59e0b'),
            createComparisonRow('รายได้', monthStats.revenue, lastMonthStats.revenue),
            createComparisonRow('ปริมาณ', monthStats.volume, lastMonthStats.volume, ''),
            createComparisonRow('กำไร', monthStats.profit, lastMonthStats.profit),
            createComparisonRow('บิล', monthStats.txCount, lastMonthStats.txCount, ''),
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📅 สัปดาห์นี้ vs สัปดาห์ก่อน', '#3b82f6'),
            createComparisonRow('รายได้', weekStats.revenue, prevWeekStats.revenue),
            createComparisonRow('ปริมาณ', weekStats.volume, prevWeekStats.volume, ''),
            { type: 'separator', margin: 'lg' },
            createSectionTitle('🌅 วันนี้ vs เมื่อวาน', '#10b981'),
            createComparisonRow('รายได้', todayStats.revenue, yesterdayStats.revenue),
            createComparisonRow('ปริมาณ', todayStats.volume, yesterdayStats.volume, '')
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

function replyForecast(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const dateGroups = {};
    salesLogs.forEach(l => {
      const date = new Date(l.timestamp).toISOString().slice(0, 10);
      if (!dateGroups[date]) dateGroups[date] = { qty: 0, rev: 0 };
      dateGroups[date].qty += Number(l.qty || 0);
      dateGroups[date].rev += Number(l.total || 0);
    });
    const dates = Object.keys(dateGroups).sort();
    if (dates.length < 3) { replyText(replyToken, '❌ ข้อมูลไม่เพียงพอ (ต้องมีอย่างน้อย 3 วัน)'); return; }
    const last7Days = dates.slice(-7).map(d => dateGroups[d].qty);
    const avg7 = last7Days.reduce((a, b) => a + b, 0) / last7Days.length;
    const last3Days = dates.slice(-3).map(d => dateGroups[d].qty);
    const avg3 = last3Days.reduce((a, b) => a + b, 0) / last3Days.length;
    const n = dates.length;
    const xValues = dates.map((_, i) => i);
    const yValues = dates.map(d => dateGroups[d].qty);
    const sumX = xValues.reduce((a, b) => a + b, 0);
    const sumY = yValues.reduce((a, b) => a + b, 0);
    const sumXY = xValues.reduce((sum, x, i) => sum + x * yValues[i], 0);
    const sumX2 = xValues.reduce((sum, x) => sum + x * x, 0);
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    const forecastDays = [];
    let totalForecast = 0;
    for (let i = 1; i <= 7; i++) {
      const predict = Math.max(0, Math.round(slope * (n + i - 1) + intercept));
      forecastDays.push(predict);
      totalForecast += predict;
    }
    const avgPrice = salesLogs.length > 0 ? salesLogs.reduce((s, l) => s + Number(l.total || 0), 0) / salesLogs.reduce((s, l) => s + Number(l.qty || 0), 0) : 35;
    const revForecast = Math.round(totalForecast * avgPrice);
    let trendText, trendEmoji, trendColor;
    if (slope > 0.5) { trendText = 'เพิ่มขึ้น'; trendEmoji = '📈'; trendColor = '#10b981'; }
    else if (slope < -0.5) { trendText = 'ลดลง'; trendEmoji = '📉'; trendColor = '#ef4444'; }
    else { trendText = 'คงที่'; trendEmoji = '➡️'; trendColor = '#f59e0b'; }
    const variance = yValues.reduce((sum, y, i) => sum + Math.pow(y - (slope * i + intercept), 2), 0) / n;
    const stdDev = Math.sqrt(variance);
    const confidence = stdDev < 3 ? 'สูง' : stdDev < 8 ? 'ปานกลาง' : 'ต่ำ';
    const confColor = stdDev < 3 ? '#10b981' : stdDev < 8 ? '#f59e0b' : '#ef4444';
    const dateStrs = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.'];
    const now = new Date();
    const forecastRows = forecastDays.map((qty, i) => {
      const futureDate = new Date(now.getTime() + (i + 1) * 24 * 60 * 60 * 1000);
      const dayStr = dateStrs[(futureDate.getDay() + 6) % 7];
      const dateStr = futureDate.getDate() + '/' + (futureDate.getMonth() + 1);
      return {
        type: 'box', layout: 'horizontal',
        contents: [
          { type: 'text', text: dayStr + ' ' + dateStr, size: 'xs', color: '#9ca3af', flex: 3 },
          { type: 'text', text: qty + ' ขวด', size: 'xs', color: '#ffffff', align: 'end', flex: 3, weight: 'bold' }
        ], margin: 'xs'
      };
    });
    const flexMessage = {
      type: 'flex',
      altText: 'พยากรณ์ยอดขาย',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '🔮 พยากรณ์ยอดขาย', weight: 'bold', color: '#8b5cf6', size: 'lg' },
            { type: 'text', text: 'Linear Regression + Moving Average', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: 'คาดการณ์ 7 วันข้างหน้า', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: totalForecast + ' ขวด', color: '#8b5cf6', size: 'xxl', weight: 'bold' },
              { type: 'text', text: '≈ ฿' + revForecast.toLocaleString() + ' รายได้', color: '#10b981', size: 'sm', margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('แนวโน้ม', trendEmoji + ' ' + trendText, trendColor), createStatBox('ความแม่นยำ', confidence, confColor)] },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📅 รายละเอียดรายวัน', '#8b5cf6'),
            { type: 'box', layout: 'vertical', contents: forecastRows, margin: 'sm' },
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '💡 ค่าเฉลี่ย 7 วัน: ' + avg7.toFixed(1) + ' ขวด/วัน', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: '💡 ค่าเฉลี่ย 3 วัน: ' + avg3.toFixed(1) + ' ขวด/วัน', color: '#9ca3af', size: 'xs', margin: 'xs' }
            ], margin: 'lg' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

function replyFullAnalysis(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const expenses = data.expenses;
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const recentSales = salesLogs.filter(l => new Date(l.timestamp) >= thirtyDaysAgo);
    const recentExp = expenses.filter(e => new Date(e.timestamp) >= thirtyDaysAgo);
    const revenue = recentSales.reduce((s, l) => s + Number(l.total || 0), 0);
    const totalExp = recentExp.reduce((s, e) => s + Number(e.amount || 0), 0);
    const volume = recentSales.reduce((s, l) => s + Number(l.qty || 0), 0);
    const profit = revenue - totalExp;
    const avgCost = getAverageUnitCost();
    const cogs = volume * avgCost;
    const grossMargin = revenue > 0 ? ((revenue - cogs) / revenue) * 100 : 0;
    const netMargin = revenue > 0 ? (profit / revenue) * 100 : 0;
    const daysWithSales = new Set(recentSales.map(l => new Date(l.timestamp).toDateString())).size || 1;
    const velocity = volume / daysWithSales;
    const avgPrice = volume > 0 ? revenue / volume : 35;
    const breakEven = (avgPrice - avgCost) > 0 ? Math.ceil(totalExp / (avgPrice - avgCost)) : 0;
    const atv = recentSales.length > 0 ? revenue / recentSales.length : 0;
    const cashRev = recentSales.filter(l => l.paymentMethod === 'CASH').reduce((s, l) => s + Number(l.total || 0), 0);
    const transferRev = revenue - cashRev;
    const prodCounts = {};
    recentSales.forEach(l => { prodCounts[l.productName] = (prodCounts[l.productName] || 0) + Number(l.qty || 0); });
    const topProd = Object.keys(prodCounts).sort((a, b) => prodCounts[b] - prodCounts[a])[0] || '-';
    let healthScore = 50;
    if (netMargin > 30) healthScore += 20; else if (netMargin > 15) healthScore += 10; else if (netMargin < 0) healthScore -= 20;
    if (velocity > 20) healthScore += 15; else if (velocity > 10) healthScore += 8;
    if (revenue > 0 && cashRev / revenue > 0.5) healthScore += 10;
    healthScore = Math.max(0, Math.min(100, healthScore));
    const grade = healthScore >= 80 ? 'A (ดีเยี่ยม)' : healthScore >= 65 ? 'B (ดี)' : healthScore >= 50 ? 'C (ปานกลาง)' : healthScore >= 35 ? 'D (ต้องปรับปรุง)' : 'F (วิกฤติ)';
    const gradeColor = healthScore >= 80 ? '#10b981' : healthScore >= 65 ? '#3b82f6' : healthScore >= 50 ? '#f59e0b' : '#ef4444';
    const flexMessage = {
      type: 'flex',
      altText: 'รายงานวิเคราะห์ธุรกิจ (BI)',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '📊 รายงานวิเคราะห์ธุรกิจ', weight: 'bold', color: '#8b5cf6', size: 'lg' },
            { type: 'text', text: '30 วันล่าสุด · Business Intelligence', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '🏥 คะแนนสุขภาพธุรกิจ', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: healthScore + '/100', color: gradeColor, size: 'xxl', weight: 'bold' },
              { type: 'text', text: 'เกรด ' + grade, color: gradeColor, size: 'sm', margin: 'sm', weight: 'bold' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('รายได้', '฿' + Math.round(revenue).toLocaleString(), '#10b981'), createStatBox('กำไรสุทธิ', '฿' + Math.round(profit).toLocaleString(), profit >= 0 ? '#f59e0b' : '#ef4444')] },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('ปริมาณ', volume + ' ขวด', '#3b82f6'), createStatBox('มูลค่า/บิล', '฿' + Math.round(atv), '#8b5cf6')] },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('💹 วิเคราะห์การเงิน', '#10b981'),
            createAnalysisRow('อัตรากำไรขั้นต้น', grossMargin.toFixed(1) + '%', grossMargin > 50 ? '#10b981' : '#f59e0b'),
            createAnalysisRow('อัตรากำไรสุทธิ', netMargin.toFixed(1) + '%', netMargin > 20 ? '#10b981' : netMargin > 0 ? '#f59e0b' : '#ef4444'),
            createAnalysisRow('ต้นทุนต่อขวด', '฿' + avgCost.toFixed(1), '#3b82f6'),
            createAnalysisRow('จุดคุ้มทุน', breakEven + ' ขวด', '#8b5cf6'),
            { type: 'separator', margin: 'lg' },
            createSectionTitle('⚡ ประสิทธิภาพ', '#3b82f6'),
            createAnalysisRow('ความเร็วขาย', velocity.toFixed(1) + ' ขวด/วัน', '#10b981'),
            createAnalysisRow('จำนวนบิล', recentSales.length + ' บิล', '#8b5cf6'),
            createAnalysisRow('เงินสด', '฿' + Math.round(cashRev).toLocaleString() + ' (' + (revenue > 0 ? ((cashRev / revenue) * 100).toFixed(0) : 0) + '%)', '#10b981'),
            createAnalysisRow('โอนเงิน', '฿' + Math.round(transferRev).toLocaleString() + ' (' + (revenue > 0 ? ((transferRev / revenue) * 100).toFixed(0) : 0) + '%)', '#3b82f6'),
            { type: 'separator', margin: 'lg' },
            createAnalysisRow('🏆 สินค้าขายดี', topProd, '#f59e0b'),
            { type: 'separator', margin: 'lg' },
            createSectionTitle('💡 คำแนะนำ', '#f59e0b'),
            { type: 'text', text: generateQuickAdvice(healthScore, netMargin, velocity), color: '#d1d5db', size: 'xs', wrap: true, margin: 'sm' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

// ============================================================================
// 📌 replyCashFlow, replyCashFlowForecast, replyCustomerStats, replyCostAnalysis
// ============================================================================
function replyCashFlow(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthLogs = data.logs.filter(l => new Date(l.timestamp) >= monthStart);
    const monthExpenses = data.expenses.filter(e => new Date(e.timestamp) >= monthStart);
    const cashIn = monthLogs.filter(l => l.type === 'OUT' && l.paymentMethod === 'CASH').reduce((s, l) => s + Number(l.total || 0), 0);
    const transferIn = monthLogs.filter(l => l.type === 'OUT' && l.paymentMethod === 'TRANSFER').reduce((s, l) => s + Number(l.total || 0), 0);
    const totalInflow = cashIn + transferIn;
    const cashOut = monthExpenses.filter(e => e.paymentMethod === 'CASH').reduce((s, e) => s + Number(e.amount || 0), 0);
    const transferOut = monthExpenses.filter(e => e.paymentMethod === 'TRANSFER').reduce((s, e) => s + Number(e.amount || 0), 0);
    const totalOutflow = cashOut + transferOut;
    const netCash = totalInflow - totalOutflow;
    const cashOnHand = cashIn - cashOut;
    const bankBalance = transferIn - transferOut;
    const expByCat = {};
    monthExpenses.forEach(e => { expByCat[e.category] = (expByCat[e.category] || 0) + Number(e.amount || 0); });
    const catLabels = { LEAVES: '🍃 ใบกระท่อม', COKE: '🥤 โค้ก', SYRUP_RED: '🧪 ยาแก้ไอฝาแดง', SYRUP_BM: '🧪 ยาแก้ไอ BM', BOTTLE: '🍾 ขวด/สติกเกอร์', GAS: '🔥 แก๊ส', PLUM: '🫐 บ๊วย', OTHER: '📦 อื่นๆ' };
    const outflowRows = Object.keys(expByCat).sort((a, b) => expByCat[b] - expByCat[a]).map(cat => createAnalysisRow(catLabels[cat] || cat, '-฿' + expByCat[cat].toLocaleString(), '#ef4444'));
    const flexMessage = {
      type: 'flex',
      altText: 'Cash Flow Statement',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '💵 CASH FLOW', weight: 'bold', color: '#10b981', size: 'xl' },
            { type: 'text', text: 'กระแสเงินสดเดือนนี้', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '💰 กระแสเงินสดสุทธิ', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: '฿' + netCash.toLocaleString(), color: netCash >= 0 ? '#10b981' : '#ef4444', size: 'xxl', weight: 'bold' },
              { type: 'text', text: netCash >= 0 ? '✅ เงินเพิ่มขึ้น' : '⚠️ เงินลดลง', color: netCash >= 0 ? '#10b981' : '#ef4444', size: 'sm', margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('⬆️ เงินเข้า', '#10b981'),
            createAnalysisRow('💵 เงินสด', '+฿' + cashIn.toLocaleString(), '#10b981'),
            createAnalysisRow('📱 โอนเงิน', '+฿' + transferIn.toLocaleString(), '#3b82f6'),
            createAnalysisRow('รวมเงินเข้า', '+฿' + totalInflow.toLocaleString(), '#10b981'),
            { type: 'separator', margin: 'lg' },
            createSectionTitle('⬇️ เงินออก', '#ef4444'),
            ...outflowRows,
            createAnalysisRow('รวมเงินออก', '-฿' + totalOutflow.toLocaleString(), '#ef4444'),
            { type: 'separator', margin: 'lg' },
            createSectionTitle('🏦 ยอดคงเหลือ', '#f59e0b'),
            createAnalysisRow('💵 เงินสดคงเหลือ', '฿' + cashOnHand.toLocaleString(), cashOnHand >= 0 ? '#10b981' : '#ef4444'),
            createAnalysisRow('📱 ยอดในธนาคาร', '฿' + bankBalance.toLocaleString(), bankBalance >= 0 ? '#3b82f6' : '#ef4444'),
            createAnalysisRow('🏦 รวมทั้งหมด', '฿' + (cashOnHand + bankBalance).toLocaleString(), '#f59e0b')
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

function replyCashFlowForecast(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const expenses = data.expenses;
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const recentSales = salesLogs.filter(l => new Date(l.timestamp) >= thirtyDaysAgo);
    const recentExp = expenses.filter(e => new Date(e.timestamp) >= thirtyDaysAgo);
    const dailyRev = recentSales.reduce((s, l) => s + Number(l.total || 0), 0) / 30;
    const dailyExp = recentExp.reduce((s, e) => s + Number(e.amount || 0), 0) / 30;
    const dailyNet = dailyRev - dailyExp;
    const dailyRevArr = [];
    for (let i = 29; i >= 0; i--) {
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      const dayRev = salesLogs.filter(l => { const d = new Date(l.timestamp); return d >= dayStart && d < dayEnd; }).reduce((s, l) => s + Number(l.total || 0), 0);
      dailyRevArr.push(dayRev);
    }
    const sumX = dailyRevArr.map((_, i) => i).reduce((a, b) => a + b, 0);
    const sumY = dailyRevArr.reduce((a, b) => a + b, 0);
    const sumXY = dailyRevArr.reduce((sum, y, i) => sum + i * y, 0);
    const sumX2 = dailyRevArr.map((_, i) => i * i).reduce((a, b) => a + b, 0);
    const slope = (30 * sumXY - sumX * sumY) / (30 * sumX2 - sumX * sumX);
    const growthRate = dailyRev > 0 ? slope / dailyRev : 0;
    const forecasts = [];
    let cumulative = 0, cumInflow = 0, cumOutflow = 0;
    for (let i = 1; i <= 30; i++) {
      const projectedRev = dailyRev * (1 + growthRate * i);
      const projectedExp = dailyExp;
      cumulative += (projectedRev - projectedExp);
      cumInflow += projectedRev;
      cumOutflow += projectedExp;
      if (i === 7 || i === 14 || i === 21 || i === 30) {
        forecasts.push({ day: i, inflow: cumInflow, outflow: cumOutflow, net: cumulative });
      }
    }
    const forecastRows = forecasts.map(f => {
      const netColor = f.net >= 0 ? '#10b981' : '#ef4444';
      return {
        type: 'box', layout: 'horizontal',
        contents: [
          { type: 'text', text: 'Day ' + f.day, size: 'xs', color: '#9ca3af', flex: 2 },
          { type: 'text', text: '+฿' + Math.round(f.inflow).toLocaleString(), size: 'xs', color: '#10b981', align: 'end', flex: 3 },
          { type: 'text', text: '-฿' + Math.round(f.outflow).toLocaleString(), size: 'xs', color: '#ef4444', align: 'end', flex: 3 },
          { type: 'text', text: '฿' + Math.round(f.net).toLocaleString(), size: 'xs', color: netColor, align: 'end', flex: 3, weight: 'bold' }
        ], margin: 'sm'
      };
    });
    const finalNet = cumulative;
    const trendText = growthRate > 0.01 ? '📈 เพิ่มขึ้น' : growthRate < -0.01 ? '📉 ลดลง' : '➡️ คงที่';
    const trendColor = growthRate > 0.01 ? '#10b981' : growthRate < -0.01 ? '#ef4444' : '#f59e0b';
    const flexMessage = {
      type: 'flex',
      altText: 'Cash Flow Forecast',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '🔮 CASH FLOW FORECAST', weight: 'bold', color: '#8b5cf6', size: 'xl' },
            { type: 'text', text: 'พยากรณ์กระแสเงินสด 30 วัน', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '💰 คาดการณ์สุทธิ 30 วัน', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: '฿' + Math.round(finalNet).toLocaleString(), color: finalNet >= 0 ? '#10b981' : '#ef4444', size: 'xxl', weight: 'bold' },
              { type: 'text', text: 'แนวโน้ม ' + trendText, color: trendColor, size: 'sm', margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('รายได้/วัน', '฿' + Math.round(dailyRev).toLocaleString(), '#10b981'), createStatBox('รายจ่าย/วัน', '฿' + Math.round(dailyExp).toLocaleString(), '#ef4444')] },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('สุทธิ/วัน', '฿' + Math.round(dailyNet).toLocaleString(), dailyNet >= 0 ? '#10b981' : '#ef4444'), createStatBox('อัตราเติบโต', (growthRate * 100).toFixed(2) + '%', trendColor)] },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📅 พยากรณ์รายช่วง', '#8b5cf6'),
            { type: 'box', layout: 'horizontal', contents: [
              { type: 'text', text: 'ช่วง', size: 'xxs', color: '#6b7280', flex: 2 },
              { type: 'text', text: 'เข้า', size: 'xxs', color: '#10b981', align: 'end', flex: 3 },
              { type: 'text', text: 'ออก', size: 'xxs', color: '#ef4444', align: 'end', flex: 3 },
              { type: 'text', text: 'สุทธิ', size: 'xxs', color: '#ffffff', align: 'end', flex: 3 }
            ]},
            { type: 'box', layout: 'vertical', contents: forecastRows, margin: 'sm' },
            { type: 'separator', margin: 'lg' },
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '💡 คำแนะนำ', size: 'xs', color: '#f59e0b', weight: 'bold' },
              { type: 'text', text: generateCashAdvice(finalNet, dailyNet, growthRate), size: 'xs', color: '#d1d5db', wrap: true, margin: 'sm' }
            ], backgroundColor: '#1a1f2e', paddingAll: '10px', cornerRadius: '10px', margin: 'md' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

function replySalesReport(replyToken, period) {
  try {
    const data = getFilteredDataByPeriod(period);
    const { logs, expenses } = data;
    const salesLogs = logs.filter(l => l.type === 'OUT');
    const totalRev = salesLogs.reduce((s, l) => s + Number(l.total || 0), 0);
    const totalVol = salesLogs.reduce((s, l) => s + Number(l.qty || 0), 0);
    const totalExp = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
    const profit = totalRev - totalExp;
    const txCount = salesLogs.length;
    const redQty = salesLogs.filter(l => l.recipeType === 'RED').reduce((s, l) => s + Number(l.qty || 0), 0);
    const bmQty = salesLogs.filter(l => l.recipeType === 'BM').reduce((s, l) => s + Number(l.qty || 0), 0);
    const origQty = salesLogs.filter(l => l.recipeType === 'ORIGINAL').reduce((s, l) => s + Number(l.qty || 0), 0);
    const cashRev = salesLogs.filter(l => l.paymentMethod === 'CASH').reduce((s, l) => s + Number(l.total || 0), 0);
    const transferRev = totalRev - cashRev;
    const periodText = { today: 'วันนี้', yesterday: 'เมื่อวาน', '7days': '7 วันย้อนหลัง', thisMonth: 'เดือนนี้' }[period] || period;
    const flexMessage = {
      type: 'flex',
      altText: 'รายงานยอดขาย ' + periodText,
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '📊 รายงาน ' + periodText, weight: 'bold', color: '#10b981', size: 'lg' },
            { type: 'text', text: new Date().toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }), color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '💰 ยอดขายรวม', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: '฿' + totalRev.toLocaleString(), color: '#10b981', size: 'xxl', weight: 'bold' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('📦 ขวด', String(totalVol), '#3b82f6'), createStatBox('🧾 บิล', String(txCount), '#8b5cf6')] },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('🔴 ฝาแดง', redQty + ' ขวด', '#ef4444'), createStatBox('🟡 BM', bmQty + ' ขวด', '#f59e0b'), createStatBox('⚪ Original', origQty + ' ขวด', '#9ca3af')] },
            { type: 'box', layout: 'vertical', contents: [
              { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: 'รายได้', size: 'sm', color: '#9ca3af', flex: 3 }, { type: 'text', text: '฿' + totalRev.toLocaleString(), size: 'sm', color: '#10b981', align: 'end', flex: 4, weight: 'bold' }] },
              { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: 'รายจ่าย', size: 'sm', color: '#9ca3af', flex: 3 }, { type: 'text', text: '฿' + totalExp.toLocaleString(), size: 'sm', color: '#ef4444', align: 'end', flex: 4, weight: 'bold' }], margin: 'sm' },
              { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: 'กำไรสุทธิ', size: 'sm', color: '#ffffff', flex: 3, weight: 'bold' }, { type: 'text', text: '฿' + profit.toLocaleString(), size: 'md', color: profit >= 0 ? '#f59e0b' : '#ef4444', align: 'end', flex: 4, weight: 'bold' }], margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px', margin: 'md' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('💵 เงินสด', '฿' + cashRev.toLocaleString(), '#10b981'), createStatBox('📱 โอน', '฿' + transferRev.toLocaleString(), '#3b82f6')], margin: 'md' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

function replyProfitReport(replyToken) {
  try {
    const thisMonth = getFilteredDataByPeriod('thisMonth');
    const lastMonth = getFilteredDataByPeriod('lastMonth');
    const thisRev = thisMonth.logs.filter(l => l.type === 'OUT').reduce((s, l) => s + Number(l.total || 0), 0);
    const thisExp = thisMonth.expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
    const thisProfit = thisRev - thisExp;
    const lastRev = lastMonth.logs.filter(l => l.type === 'OUT').reduce((s, l) => s + Number(l.total || 0), 0);
    const lastExp = lastMonth.expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
    const lastProfit = lastRev - lastExp;
    const profitChange = lastProfit !== 0 ? ((thisProfit - lastProfit) / Math.abs(lastProfit)) * 100 : 0;
    const changeEmoji = profitChange >= 0 ? '📈' : '📉';
    const changeColor = profitChange >= 0 ? '#10b981' : '#ef4444';
    const expByCat = {};
    thisMonth.expenses.forEach(e => { expByCat[e.category] = (expByCat[e.category] || 0) + Number(e.amount || 0); });
    const catLabels = { LEAVES: '🍃 ใบกระท่อม', COKE: '🥤 โค้ก', SYRUP_RED: '🧪 ยาแก้ไอฝาแดง', SYRUP_BM: '🧪 ยาแก้ไอ BM', BOTTLE: '🍾 ขวด/สติกเกอร์', GAS: '🔥 แก๊ส/ไฟ', PLUM: '🫐 บ๊วย', OTHER: '📦 อื่นๆ' };
    const expRows = Object.keys(expByCat).sort((a, b) => expByCat[b] - expByCat[a]).slice(0, 5).map(cat => ({
      type: 'box', layout: 'horizontal',
      contents: [
        { type: 'text', text: catLabels[cat] || cat, size: 'xs', color: '#9ca3af', flex: 5 },
        { type: 'text', text: '฿' + expByCat[cat].toLocaleString(), size: 'xs', color: '#ffffff', align: 'end', flex: 3, weight: 'bold' }
      ], margin: 'xs'
    }));
    const flexMessage = {
      type: 'flex',
      altText: 'รายงานกำไร-ขาดทุน',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '💰 วิเคราะห์กำไร-ขาดทุน', weight: 'bold', color: '#f59e0b', size: 'lg' },
            { type: 'text', text: 'เดือนนี้ vs เดือนที่แล้ว', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: 'กำไรสุทธิเดือนนี้', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: '฿' + thisProfit.toLocaleString(), color: thisProfit >= 0 ? '#10b981' : '#ef4444', size: 'xxl', weight: 'bold' },
              { type: 'text', text: changeEmoji + ' ' + (profitChange >= 0 ? '+' : '') + profitChange.toFixed(1) + '% เทียบเดือนก่อน', color: changeColor, size: 'xs', margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('รายได้', '฿' + thisRev.toLocaleString(), '#10b981'), createStatBox('รายจ่าย', '฿' + thisExp.toLocaleString(), '#ef4444')] },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📋 รายจ่ายแยกหมวด', '#f59e0b'),
            { type: 'box', layout: 'vertical', contents: expRows.length > 0 ? expRows : [{ type: 'text', text: 'ไม่มีรายจ่ายเดือนนี้', color: '#6b7280', size: 'xs' }], margin: 'sm' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

function replyTopProducts(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const prodStats = {};
    salesLogs.forEach(l => {
      if (!prodStats[l.productName]) prodStats[l.productName] = { qty: 0, rev: 0, recipeType: l.recipeType };
      prodStats[l.productName].qty += Number(l.qty || 0);
      prodStats[l.productName].rev += Number(l.total || 0);
    });
    const sorted = Object.keys(prodStats).sort((a, b) => prodStats[b].qty - prodStats[a].qty).slice(0, 5);
    const totalQty = salesLogs.reduce((s, l) => s + Number(l.qty || 0), 0);
    const rankEmojis = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    const topRows = sorted.map((name, idx) => {
      const s = prodStats[name];
      const percent = totalQty > 0 ? ((s.qty / totalQty) * 100).toFixed(1) : 0;
      return {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: rankEmojis[idx] + ' ' + name, size: 'sm', color: '#ffffff', weight: 'bold', flex: 6, wrap: true },
            { type: 'text', text: s.qty + ' ขวด', size: 'sm', color: '#10b981', align: 'end', flex: 2, weight: 'bold' }
          ]},
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'รายได้ ฿' + s.rev.toLocaleString(), size: 'xs', color: '#9ca3af', flex: 5 },
            { type: 'text', text: percent + '%', size: 'xs', color: '#f59e0b', align: 'end', flex: 3 }
          ], margin: 'xs' }
        ], margin: 'lg'
      };
    });
    const flexMessage = {
      type: 'flex',
      altText: 'สินค้าขายดี Top 5',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '🏆 สินค้าขายดี Top 5', weight: 'bold', color: '#f59e0b', size: 'lg' },
            { type: 'text', text: 'รวมทั้งหมด ' + totalQty + ' ขวด', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical',
          contents: topRows.length > 0 ? topRows : [{ type: 'text', text: 'ยังไม่มีข้อมูลการขาย', color: '#6b7280', size: 'sm' }],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

function replyCostAnalysis(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const expenses = data.expenses;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentExp = expenses.filter(e => new Date(e.timestamp) >= thirtyDaysAgo);
    const recentSales = salesLogs.filter(l => new Date(l.timestamp) >= thirtyDaysAgo);
    const expByCat = {};
    recentExp.forEach(e => { expByCat[e.category] = (expByCat[e.category] || 0) + Number(e.amount || 0); });
    const totalCost = Object.values(expByCat).reduce((a, b) => a + b, 0);
    const volume = recentSales.reduce((s, l) => s + Number(l.qty || 0), 0);
    const costPerBottle = volume > 0 ? totalCost / volume : 0;
    const catLabels = { LEAVES: '🍃 ใบกระท่อม', COKE: '🥤 โค้ก', SYRUP_RED: '🧪 ยาแก้ไอฝาแดง', SYRUP_BM: '🧪 ยาแก้ไอ BM', BOTTLE: '🍾 ขวด/สติกเกอร์', GAS: '🔥 แก๊ส/ไฟ', PLUM: '🫐 บ๊วย', OTHER: '📦 อื่นๆ' };
    const costRows = Object.keys(expByCat).sort((a, b) => expByCat[b] - expByCat[a]).map(cat => {
      const amount = expByCat[cat];
      const percent = totalCost > 0 ? ((amount / totalCost) * 100).toFixed(1) : 0;
      return {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: catLabels[cat] || cat, size: 'xs', color: '#e5e7eb', flex: 5 },
            { type: 'text', text: '฿' + amount.toLocaleString(), size: 'xs', color: '#ef4444', align: 'end', flex: 3, weight: 'bold' }
          ]},
          { type: 'text', text: percent + '% ของต้นทุนรวม', size: 'xxs', color: '#6b7280', margin: 'xs' }
        ], margin: 'md'
      };
    });
    const flexMessage = {
      type: 'flex',
      altText: 'วิเคราะห์ต้นทุน',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '💸 วิเคราะห์ต้นทุน', weight: 'bold', color: '#ef4444', size: 'lg' },
            { type: 'text', text: '30 วันล่าสุด', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: 'ต้นทุนรวม 30 วัน', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: '฿' + totalCost.toLocaleString(), color: '#ef4444', size: 'xxl', weight: 'bold' },
              { type: 'text', text: 'ต้นทุนต่อขวด ฿' + costPerBottle.toFixed(1), color: '#f59e0b', size: 'sm', margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📋 รายละเอียดตามหมวด', '#ef4444'),
            { type: 'box', layout: 'vertical', contents: costRows.length > 0 ? costRows : [{ type: 'text', text: 'ไม่มีข้อมูลรายจ่าย', color: '#6b7280', size: 'xs' }] }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

function replyCustomerStats(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const dayGroups = {};
    salesLogs.forEach(l => {
      const date = new Date(l.timestamp).toDateString();
      if (!dayGroups[date]) dayGroups[date] = { count: 0, rev: 0, vol: 0 };
      dayGroups[date].count++;
      dayGroups[date].rev += Number(l.total || 0);
      dayGroups[date].vol += Number(l.qty || 0);
    });
    const days = Object.keys(dayGroups);
    const totalBills = salesLogs.length;
    const totalRev = salesLogs.reduce((s, l) => s + Number(l.total || 0), 0);
    const atv = totalBills > 0 ? totalRev / totalBills : 0;
    let bestDay = null, bestRev = 0;
    days.forEach(d => { if (dayGroups[d].rev > bestRev) { bestRev = dayGroups[d].rev; bestDay = d; } });
    const weekdayCount = [0, 0, 0, 0, 0, 0, 0];
    salesLogs.forEach(l => {
      const day = new Date(l.timestamp).getDay();
      const idx = (day + 6) % 7;
      weekdayCount[idx] += Number(l.qty || 0);
    });
    const dayNames = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.'];
    const maxDay = Math.max(...weekdayCount) || 1;
    const weekdayRows = weekdayCount.map((count, i) => {
      const barLen = Math.round((count / maxDay) * 20);
      const bar = '█'.repeat(barLen);
      return {
        type: 'box', layout: 'horizontal',
        contents: [
          { type: 'text', text: dayNames[i], size: 'xs', color: '#9ca3af', flex: 1 },
          { type: 'text', text: bar, size: 'xs', color: '#10b981', flex: 5 },
          { type: 'text', text: String(count), size: 'xs', color: '#ffffff', align: 'end', flex: 2, weight: 'bold' }
        ], margin: 'xs'
      };
    });
    const flexMessage = {
      type: 'flex',
      altText: 'สถิติลูกค้า',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '👥 สถิติลูกค้า', weight: 'bold', color: '#8b5cf6', size: 'lg' },
            { type: 'text', text: 'ภาพรวมทั้งหมด', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [createStatBox('บิลทั้งหมด', String(totalBills), '#10b981'), createStatBox('ค่าเฉลี่ย/บิล', '฿' + Math.round(atv), '#f59e0b')] },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📅 วันที่ขายดีที่สุด', '#8b5cf6'),
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: bestDay || '-', size: 'sm', color: '#ffffff', weight: 'bold' },
              { type: 'text', text: '฿' + bestRev.toLocaleString() + ' จาก ' + (bestDay ? dayGroups[bestDay].count : 0) + ' บิล', size: 'xs', color: '#10b981', margin: 'xs' }
            ], margin: 'sm' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📊 การกระจายตามวัน', '#8b5cf6'),
            { type: 'box', layout: 'vertical', contents: weekdayRows, margin: 'sm' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ เกิดข้อผิดพลาด: ' + err.toString()); }
}

console.log('🍃 KRATOM POS v' + CONFIG.VERSION + ' — Part 3 loaded (Analytics, Reports)');
// ============================================================================
// 🎯 ADVANCED KPI COMMANDS — 35+ ฟังก์ชัน (ใช้ StockBalance)
// ============================================================================

// ---------- 1. SALES PERFORMANCE KPI DASHBOARD ----------
function replySalesKPIDashboard(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const logs = data.logs.filter(l => l.type === 'OUT');
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now.getTime() - 7 * 86400000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const today = calcStats(data.logs, data.expenses, todayStart, now);
    const week = calcStats(data.logs, data.expenses, weekStart, now);
    const month = calcStats(data.logs, data.expenses, monthStart, now);
    const lastMonth = calcStats(data.logs, data.expenses, lastMonthStart, monthStart);
    const daysCount = Math.max(1, Math.ceil((now - monthStart) / 86400000));
    const avgDailyRevenue = month.revenue / daysCount;
    const atv = month.txCount > 0 ? month.revenue / month.txCount : 0;
    const ipt = month.txCount > 0 ? month.volume / month.txCount : 0;
    const velocity = month.volume / daysCount;
    const hourBuckets = new Array(24).fill(0);
    const recentSales = logs.filter(l => new Date(l.timestamp) >= monthStart);
    recentSales.forEach(l => { const h = new Date(l.timestamp).getHours(); hourBuckets[h] += Number(l.qty || 0); });
    let peakHour = 0, peakHourQty = 0;
    hourBuckets.forEach((v, i) => { if (v > peakHourQty) { peakHourQty = v; peakHour = i; } });
    const dayNames = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
    const dayBuckets = new Array(7).fill(0);
    const dayRevBuckets = new Array(7).fill(0);
    recentSales.forEach(l => {
      const d = new Date(l.timestamp).getDay();
      dayBuckets[d] += Number(l.qty || 0);
      dayRevBuckets[d] += Number(l.total || 0);
    });
    let peakDay = 0, peakDayQty = 0;
    dayBuckets.forEach((v, i) => { if (v > peakDayQty) { peakDayQty = v; peakDay = i; } });
    const momGrowth = lastMonth.revenue > 0 ? ((month.revenue - lastMonth.revenue) / lastMonth.revenue) * 100 : 0;
    const lastWeekStart = new Date(weekStart.getTime() - 7 * 86400000);
    const lastWeek = calcStats(data.logs, data.expenses, lastWeekStart, weekStart);
    const wowGrowth = lastWeek.revenue > 0 ? ((week.revenue - lastWeek.revenue) / lastWeek.revenue) * 100 : 0;
    const config = readConfigAsObject(SpreadsheetApp.getActiveSpreadsheet());
    const targetRev = Number(config.kpiTargetRevenue) || 50000;
    const targetVol = Number(config.kpiTargetVolume) || 1500;
    const revAch = targetRev > 0 ? (month.revenue / targetRev) * 100 : 0;
    const volAch = targetVol > 0 ? (month.volume / targetVol) * 100 : 0;
    const projRev = avgDailyRevenue * new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const projVol = (month.volume / daysCount) * new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const velocityRows = [];
    for (let i = 13; i >= 0; i--) {
      const ds = new Date(now.getTime() - i * 86400000);
      ds.setHours(0, 0, 0, 0);
      const de = new Date(ds.getTime() + 86400000);
      const dayVol = logs.filter(l => { const d = new Date(l.timestamp); return d >= ds && d < de; }).reduce((s, l) => s + Number(l.qty || 0), 0);
      velocityRows.push({ date: ds, volume: dayVol });
    }
    const maxVol = Math.max.apply(null, velocityRows.map(r => r.volume)) || 1;
    const sparkline = velocityRows.map(r => {
      const level = Math.round((r.volume / maxVol) * 7);
      return ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'][level] || '▁';
    }).join('');
    let kpiScore = 0;
    kpiScore += momGrowth > 20 ? 25 : momGrowth > 10 ? 20 : momGrowth > 0 ? 15 : momGrowth > -10 ? 8 : 0;
    kpiScore += velocity > 50 ? 25 : velocity > 20 ? 20 : velocity > 10 ? 15 : velocity > 5 ? 8 : 0;
    kpiScore += atv > 100 ? 25 : atv > 60 ? 20 : atv > 40 ? 15 : 8;
    kpiScore += volAch > 100 ? 25 : volAch > 80 ? 20 : volAch > 60 ? 15 : volAch > 40 ? 8 : 0;
    const grade = kpiScore >= 90 ? 'A+' : kpiScore >= 80 ? 'A' : kpiScore >= 70 ? 'B+' : kpiScore >= 60 ? 'B' : kpiScore >= 50 ? 'C' : kpiScore >= 40 ? 'D' : 'F';
    const gradeColor = kpiScore >= 80 ? '#10b981' : kpiScore >= 60 ? '#3b82f6' : kpiScore >= 40 ? '#f59e0b' : '#ef4444';
    const flexMessage = {
      type: 'flex',
      altText: '📊 Sales Performance Dashboard — Grade ' + grade,
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '📊 SALES PERFORMANCE', weight: 'bold', color: '#10b981', size: 'lg' },
            { type: 'text', text: 'ดัชนีชี้วัดประสิทธิภาพการขาย · เดือนนี้', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'horizontal', contents: [
              { type: 'box', layout: 'vertical', contents: [
                { type: 'text', text: '🏆 GRADE', color: '#9ca3af', size: 'xs', align: 'center' },
                { type: 'text', text: grade, color: gradeColor, size: 'xxl', weight: 'bold', align: 'center' }
              ], flex: 1, backgroundColor: '#0f1419', paddingAll: '10px', cornerRadius: '10px' },
              { type: 'box', layout: 'vertical', contents: [
                { type: 'text', text: '🎯 KPI Score', color: '#9ca3af', size: 'xs', align: 'center' },
                { type: 'text', text: kpiScore + '/100', color: gradeColor, size: 'xl', weight: 'bold', align: 'center' }
              ], flex: 1, backgroundColor: '#0f1419', paddingAll: '10px', cornerRadius: '10px', margin: 'sm' }
            ]},
            { type: 'separator', margin: 'lg' },
            createSectionTitle('💼 ดัชนีการขายหลัก', '#10b981'),
            createAnalysisRow('⚡ Velocity', velocity.toFixed(1) + ' ขวด/วัน', '#10b981'),
            createAnalysisRow('💰 Avg Daily Rev', '฿' + Math.round(avgDailyRevenue).toLocaleString(), '#3b82f6'),
            createAnalysisRow('🧾 ATV', '฿' + Math.round(atv).toLocaleString(), '#8b5cf6'),
            createAnalysisRow('📦 IPT', ipt.toFixed(2) + ' ขวด', '#f59e0b'),
            createAnalysisRow('📈 MoM Growth', (momGrowth >= 0 ? '+' : '') + momGrowth.toFixed(1) + '%', momGrowth >= 0 ? '#10b981' : '#ef4444'),
            createAnalysisRow('📊 WoW Growth', (wowGrowth >= 0 ? '+' : '') + wowGrowth.toFixed(1) + '%', wowGrowth >= 0 ? '#10b981' : '#ef4444'),
            { type: 'separator', margin: 'lg' },
            createSectionTitle('⏰ Peak Analysis', '#3b82f6'),
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('⏰ Peak Hour', String(peakHour).padStart(2, '0') + ':00', '#3b82f6'),
              createStatBox('📅 Peak Day', dayNames[peakDay], '#8b5cf6')
            ]},
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📈 Velocity 14 วันล่าสุด', '#f59e0b'),
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: sparkline, size: 'xxl', color: '#f59e0b', align: 'center' },
              { type: 'text', text: 'ต่ำสุด ' + Math.min.apply(null, velocityRows.map(r => r.volume)) + ' · สูงสุด ' + maxVol, size: 'xs', color: '#9ca3af', align: 'center', margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('🎯 Target Achievement', '#ec4899'),
            createAnalysisRow('รายได้', revAch.toFixed(0) + '%', revAch >= 100 ? '#10b981' : revAch >= 75 ? '#3b82f6' : '#f59e0b'),
            createAnalysisRow('ปริมาณ', volAch.toFixed(0) + '%', volAch >= 100 ? '#10b981' : volAch >= 75 ? '#3b82f6' : '#f59e0b'),
            createAnalysisRow('📊 คาดการณ์รายได้', '฿' + Math.round(projRev).toLocaleString(), '#10b981'),
            createAnalysisRow('📊 คาดการณ์ปริมาณ', Math.round(projVol) + ' ขวด', '#3b82f6')
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

// ---------- 2. BUSINESS KPI DASHBOARD ----------
function replyBusinessKPIDashboard(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const monthLogs = data.logs.filter(l => new Date(l.timestamp) >= monthStart && l.type === 'OUT');
    const lastMonthLogs = data.logs.filter(l => { const d = new Date(l.timestamp); return d >= lastMonthStart && d < monthStart && l.type === 'OUT'; });
    const monthExps = data.expenses.filter(e => new Date(e.timestamp) >= monthStart);
    const revenue = monthLogs.reduce((s, l) => s + Number(l.total || 0), 0);
    const volume = monthLogs.reduce((s, l) => s + Number(l.qty || 0), 0);
    const expenses = monthExps.reduce((s, e) => s + Number(e.amount || 0), 0);
    const lastRevenue = lastMonthLogs.reduce((s, l) => s + Number(l.total || 0), 0);
    let cogs = 0;
    monthLogs.forEach(l => { cogs += Number(l.qty || 0) * getUnitCostFromConfig(l.recipeType || 'RED'); });
    const grossProfit = revenue - cogs;
    const netProfit = revenue - expenses;
    const grossMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
    const netMargin = revenue > 0 ? (netProfit / revenue) * 100 : 0;
    const expenseRatio = revenue > 0 ? (expenses / revenue) * 100 : 0;
    const cogsRatio = revenue > 0 ? (cogs / revenue) * 100 : 0;
    const roi = cogs > 0 ? (netProfit / cogs) * 100 : 0;
    const products = data.products || [];
    const stockMap = readStockBalance();
    let totalStock = 0, totalStockValue = 0;
    products.forEach(p => {
      const s = stockMap[p.id] !== undefined ? stockMap[p.id] : (stockMap['name:' + p.name] || 0);
      totalStock += Math.max(0, s);
      totalStockValue += Math.max(0, s) * p.price;
    });
    const invTurnover = cogs > 0 && totalStockValue > 0 ? (cogs / totalStockValue) : 0;
    const dio = invTurnover > 0 ? 365 / invTurnover : 0;
    const cashIn = monthLogs.filter(l => l.paymentMethod === 'CASH').reduce((s, l) => s + Number(l.total || 0), 0);
    const transIn = monthLogs.filter(l => l.paymentMethod === 'TRANSFER').reduce((s, l) => s + Number(l.total || 0), 0);
    const cashOut = monthExps.filter(e => e.paymentMethod === 'CASH').reduce((s, e) => s + Number(e.amount || 0), 0);
    const transOut = monthExps.filter(e => e.paymentMethod === 'TRANSFER').reduce((s, e) => s + Number(e.amount || 0), 0);
    const netCashFlow = (cashIn + transIn) - (cashOut + transOut);
    const avgPrice = volume > 0 ? revenue / volume : 35;
    const avgCost = volume > 0 ? cogs / volume : 15;
    const cm = avgPrice - avgCost;
    const beUnits = cm > 0 ? Math.ceil(expenses / cm) : 0;
    const beRevenue = beUnits * avgPrice;
    const mos = revenue > 0 && beRevenue > 0 ? Math.max(0, ((revenue - beRevenue) / revenue) * 100) : 0;
    const momGrowth = lastRevenue > 0 ? ((revenue - lastRevenue) / lastRevenue) * 100 : 0;
    let healthScore = 0;
    if (netMargin > 30) healthScore += 25;
    else if (netMargin > 20) healthScore += 20;
    else if (netMargin > 10) healthScore += 15;
    else if (netMargin > 0) healthScore += 8;
    else healthScore -= 20;
    if (invTurnover > 4) healthScore += 20;
    else if (invTurnover > 2) healthScore += 15;
    else if (invTurnover > 1) healthScore += 8;
    if (mos > 30) healthScore += 20;
    else if (mos > 15) healthScore += 15;
    else if (mos > 0) healthScore += 8;
    if (momGrowth > 10) healthScore += 20;
    else if (momGrowth > 0) healthScore += 12;
    else if (momGrowth > -10) healthScore += 5;
    if (netCashFlow > 0) healthScore += 15;
    else healthScore -= 10;
    healthScore = Math.max(0, Math.min(100, healthScore));
    const grade = healthScore >= 80 ? 'A - ดีเยี่ยม' : healthScore >= 65 ? 'B - ดี' : healthScore >= 50 ? 'C - ปานกลาง' : healthScore >= 35 ? 'D - ต้องปรับปรุง' : 'F - วิกฤติ';
    const gradeColor = healthScore >= 80 ? '#10b981' : healthScore >= 65 ? '#3b82f6' : healthScore >= 50 ? '#f59e0b' : '#ef4444';
    const flexMessage = {
      type: 'flex',
      altText: '🏢 Business KPI Dashboard — Health ' + healthScore + '/100',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '🏢 BUSINESS KPI', weight: 'bold', color: '#8b5cf6', size: 'lg' },
            { type: 'text', text: 'ดัชนีชี้วัดธุรกิจ · เดือนนี้', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '🏥 Business Health Score', color: '#9ca3af', size: 'xs', align: 'center' },
              { type: 'text', text: healthScore + '/100', color: gradeColor, size: 'xxl', weight: 'bold', align: 'center', margin: 'xs' },
              { type: 'text', text: grade, color: gradeColor, size: 'sm', align: 'center', weight: 'bold', margin: 'xs' }
            ], backgroundColor: '#0f1419', paddingAll: '14px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('💰 Profitability', '#10b981'),
            createAnalysisRow('📊 Gross Margin', grossMargin.toFixed(1) + '%', grossMargin > 50 ? '#10b981' : grossMargin > 30 ? '#3b82f6' : '#f59e0b'),
            createAnalysisRow('💵 Net Margin', netMargin.toFixed(1) + '%', netMargin > 20 ? '#10b981' : netMargin > 0 ? '#f59e0b' : '#ef4444'),
            createAnalysisRow('📈 ROI', roi.toFixed(1) + '%', roi > 30 ? '#10b981' : roi > 0 ? '#3b82f6' : '#ef4444'),
            createAnalysisRow('💸 Expense Ratio', expenseRatio.toFixed(1) + '%', expenseRatio < 30 ? '#10b981' : expenseRatio < 50 ? '#f59e0b' : '#ef4444'),
            createAnalysisRow('🏭 COGS Ratio', cogsRatio.toFixed(1) + '%', cogsRatio < 40 ? '#10b981' : cogsRatio < 60 ? '#f59e0b' : '#ef4444'),
            { type: 'separator', margin: 'lg' },
            createSectionTitle('⚙️ Efficiency', '#3b82f6'),
            createAnalysisRow('🔄 Inventory Turnover', invTurnover.toFixed(2) + 'x', invTurnover > 2 ? '#10b981' : '#f59e0b'),
            createAnalysisRow('📅 Days Inventory (DIO)', Math.round(dio) + ' วัน', dio < 90 ? '#10b981' : dio < 180 ? '#f59e0b' : '#ef4444'),
            createAnalysisRow('📦 มูลค่าสต๊อก', '฿' + Math.round(totalStockValue).toLocaleString(), '#3b82f6'),
            createAnalysisRow('🏭 คงเหลือ', totalStock + ' ขวด', '#8b5cf6'),
            { type: 'separator', margin: 'lg' },
            createSectionTitle('💵 Financial Health', '#f59e0b'),
            createAnalysisRow('💰 Net Cash Flow', '฿' + Math.round(netCashFlow).toLocaleString(), netCashFlow > 0 ? '#10b981' : '#ef4444'),
            createAnalysisRow('⚖️ Break-even', beUnits.toLocaleString() + ' ขวด', '#8b5cf6'),
            createAnalysisRow('🛡️ Margin of Safety', mos.toFixed(1) + '%', mos > 30 ? '#10b981' : mos > 0 ? '#f59e0b' : '#ef4444'),
            createAnalysisRow('📊 Contribution Margin', '฿' + cm.toFixed(2), '#f59e0b'),
            createAnalysisRow('📈 MoM Growth', (momGrowth >= 0 ? '+' : '') + momGrowth.toFixed(1) + '%', momGrowth >= 0 ? '#10b981' : '#ef4444')
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

// ---------- 3. DEEP ANALYSIS ----------
function replyDeepAnalysis(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const t30 = new Date(now.getTime() - 30 * 86400000);
    const recentSales = data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= t30);
    const totalRev = recentSales.reduce((s, l) => s + Number(l.total || 0), 0);
    const totalVol = recentSales.reduce((s, l) => s + Number(l.qty || 0), 0);
    const byProduct = {};
    recentSales.forEach(l => {
      const n = l.productName || 'ไม่ทราบ';
      if (!byProduct[n]) byProduct[n] = { rev: 0, vol: 0, rt: l.recipeType };
      byProduct[n].rev += Number(l.total || 0);
      byProduct[n].vol += Number(l.qty || 0);
    });
    const prodSorted = Object.keys(byProduct).sort((a, b) => byProduct[b].rev - byProduct[a].rev);
    let cumRev = 0;
    const abc = { A: [], B: [], C: [] };
    prodSorted.forEach(name => {
      cumRev += byProduct[name].rev;
      const pct = totalRev > 0 ? (cumRev / totalRev) * 100 : 0;
      if (pct <= 80) abc.A.push(name);
      else if (pct <= 95) abc.B.push(name);
      else abc.C.push(name);
    });
    const byCustomer = {};
    recentSales.forEach(l => {
      if (l.note && l.note.trim() && l.note.length < 50) {
        const c = l.note.trim();
        if (!byCustomer[c]) byCustomer[c] = { lastDate: 0, count: 0, total: 0 };
        const d = new Date(l.timestamp).getTime();
        if (d > byCustomer[c].lastDate) byCustomer[c].lastDate = d;
        byCustomer[c].count++;
        byCustomer[c].total += Number(l.total || 0);
      }
    });
    const dayNames = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
    const dayRev = [0, 0, 0, 0, 0, 0, 0];
    recentSales.forEach(l => { dayRev[new Date(l.timestamp).getDay()] += Number(l.total || 0); });
    const maxDayRev = Math.max.apply(null, dayRev) || 1;
    const dayRows = dayRev.map((v, i) => {
      const barLen = Math.round((v / maxDayRev) * 15);
      const bar = '█'.repeat(Math.max(0, barLen)) + '░'.repeat(Math.max(0, 15 - barLen));
      return { day: dayNames[i], revenue: v, bar: bar };
    });
    const thisWeek = calcStats(data.logs, data.expenses, new Date(now.getTime() - 7 * 86400000), now);
    const lastWeek = calcStats(data.logs, data.expenses, new Date(now.getTime() - 14 * 86400000), new Date(now.getTime() - 7 * 86400000));
    const wowGrowth = lastWeek.revenue > 0 ? ((thisWeek.revenue - lastWeek.revenue) / lastWeek.revenue) * 100 : 0;
    const totalVolProducts = Object.values(byProduct).reduce((s, p) => s + p.vol, 0);
    const hhi = Object.values(byProduct).reduce((s, p) => s + Math.pow(totalVolProducts > 0 ? (p.vol / totalVolProducts) * 100 : 0, 2), 0);
    const flexMessage = {
      type: 'flex',
      altText: '🔬 Deep Business Analysis',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '🔬 DEEP ANALYSIS', weight: 'bold', color: '#06b6d4', size: 'lg' },
            { type: 'text', text: 'วิเคราะห์เชิงลึก · 30 วันล่าสุด', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('📊 รายได้', '฿' + Math.round(totalRev).toLocaleString(), '#10b981'),
              createStatBox('📦 ขวด', String(totalVol), '#3b82f6')
            ]},
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('🧾 บิล', String(recentSales.length), '#8b5cf6'),
              createStatBox('📈 WoW', (wowGrowth >= 0 ? '+' : '') + wowGrowth.toFixed(1) + '%', wowGrowth >= 0 ? '#10b981' : '#ef4444')
            ]},
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📦 ABC Analysis (Pareto)', '#10b981'),
            { type: 'box', layout: 'vertical', contents: [
              createAnalysisRow('🥇 Class A (80% รายได้)', abc.A.length + ' รายการ', '#10b981'),
              createAnalysisRow('🥈 Class B (15%)', abc.B.length + ' รายการ', '#f59e0b'),
              createAnalysisRow('🥉 Class C (5%)', abc.C.length + ' รายการ', '#ef4444'),
              { type: 'text', text: '🏆 Top: ' + (prodSorted[0] || '-'), size: 'xs', color: '#a78bfa', margin: 'md', wrap: true }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📅 Seasonality (Day of Week)', '#8b5cf6'),
            { type: 'box', layout: 'vertical',
              contents: dayRows.map(d => ({
                type: 'box', layout: 'vertical', contents: [
                  { type: 'box', layout: 'horizontal', contents: [
                    { type: 'text', text: d.day, size: 'xs', color: '#9ca3af', flex: 1 },
                    { type: 'text', text: d.bar, size: 'xs', color: d.revenue === maxDayRev ? '#8b5cf6' : '#6b7280', flex: 4 },
                    { type: 'text', text: '฿' + Math.round(d.revenue).toLocaleString(), size: 'xxs', color: d.revenue === maxDayRev ? '#a78bfa' : '#9ca3af', align: 'end', flex: 2, weight: 'bold' }
                  ] }
                ], margin: 'xs'
              })),
              backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px'
            },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📊 Market Concentration (HHI)', '#f59e0b'),
            { type: 'box', layout: 'vertical', contents: [
              createAnalysisRow('ค่า HHI', hhi.toFixed(0), hhi > 2500 ? '#ef4444' : hhi > 1500 ? '#f59e0b' : '#10b981'),
              { type: 'text', text: hhi > 2500 ? '⚠️ เสี่ยงสูง - พึ่งพาสินค้าน้อยรายการ' : hhi > 1500 ? '🟡 ปานกลาง - ควรกระจาย' : '✅ ดี - กระจายความเสี่ยงได้ดี', size: 'xs', color: hhi > 2500 ? '#ef4444' : hhi > 1500 ? '#f59e0b' : '#10b981', margin: 'sm', wrap: true }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            _buildCustomerSegmentsBlock(byCustomer),
            { type: 'separator', margin: 'lg' },
            createSectionTitle('💡 Recommendations', '#ec4899'),
            { type: 'box', layout: 'vertical',
              contents: _buildDeepRecommendations(abc, hhi, wowGrowth),
              backgroundColor: '#1a1f2e', paddingAll: '12px', cornerRadius: '12px' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function _buildCustomerSegmentsBlock(byCustomer) {
  const now = new Date();
  let champions = 0, loyal = 0, atRisk = 0, lost = 0;
  Object.keys(byCustomer).forEach(c => {
    const days = Math.floor((now.getTime() - byCustomer[c].lastDate) / 86400000);
    const freq = byCustomer[c].count;
    if (days <= 7 && freq >= 5) champions++;
    else if (days <= 14 && freq >= 3) loyal++;
    else if (days <= 30) atRisk++;
    else lost++;
  });
  return {
    type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: '👥 Customer Segments', weight: 'bold', color: '#06b6d4', size: 'sm', margin: 'md' },
      { type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: '🏆 Champions (7วัน, 5+ บิล)', size: 'xxs', color: '#10b981', flex: 5 },
        { type: 'text', text: champions + ' คน', size: 'xs', color: '#10b981', align: 'end', flex: 3, weight: 'bold' }
      ], margin: 'sm' },
      { type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: '💎 Loyal (14วัน, 3+ บิล)', size: 'xxs', color: '#3b82f6', flex: 5 },
        { type: 'text', text: loyal + ' คน', size: 'xs', color: '#3b82f6', align: 'end', flex: 3, weight: 'bold' }
      ], margin: 'sm' },
      { type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: '⚠️ At Risk (30 วัน)', size: 'xxs', color: '#f59e0b', flex: 5 },
        { type: 'text', text: atRisk + ' คน', size: 'xs', color: '#f59e0b', align: 'end', flex: 3, weight: 'bold' }
      ], margin: 'sm' },
      { type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: '💤 Lost (30+ วัน)', size: 'xxs', color: '#ef4444', flex: 5 },
        { type: 'text', text: lost + ' คน', size: 'xs', color: '#ef4444', align: 'end', flex: 3, weight: 'bold' }
      ], margin: 'sm' }
    ],
    backgroundColor: '#0f1419',
    paddingAll: '12px',
    cornerRadius: '12px'
  };
}

function _buildDeepRecommendations(abc, hhi, wowGrowth) {
  const recs = [];
  if (abc.A.length <= 2) recs.push('⚠️ ควรขยาย Class A - ปัจจุบันพึ่งพาสินค้าน้อยรายการ');
  if (abc.C.length >= 5) recs.push('💡 พิจารณาตัด Class C หรือทำโปรโมชั่นระบาย');
  if (hhi > 2500) recs.push('🎯 เร่งกระจายสินค้าใหม่ - Concentration สูงเกินไป');
  if (wowGrowth < -10) recs.push('📉 ยอดขายลด - ควรทำโปรโมชั่นกระตุ้น');
  if (wowGrowth > 20) recs.push('🚀 เติบโตดี - ควรเพิ่มสต๊อกสินค้าขายดี');
  if (recs.length === 0) recs.push('✅ ธุรกิจมีสุขภาพดี - รักษามาตรฐานและติดตามอย่างต่อเนื่อง');
  return recs.map(r => ({ type: 'text', text: '• ' + r, size: 'xs', color: '#d1d5db', wrap: true, margin: 'sm' }));
}

// ---------- 4. RFM ANALYSIS ----------
function replyRFMAnalysis(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const byCustomer = {};
    salesLogs.forEach(l => {
      if (l.note && l.note.trim() && l.note.length < 50) {
        const c = l.note.trim();
        if (!byCustomer[c]) byCustomer[c] = { lastDate: 0, count: 0, total: 0, firstDate: Infinity };
        const d = new Date(l.timestamp).getTime();
        if (d > byCustomer[c].lastDate) byCustomer[c].lastDate = d;
        if (d < byCustomer[c].firstDate) byCustomer[c].firstDate = d;
        byCustomer[c].count++;
        byCustomer[c].total += Number(l.total || 0);
      }
    });
    const customers = Object.keys(byCustomer).map(name => {
      const c = byCustomer[name];
      const recencyDays = Math.floor((now.getTime() - c.lastDate) / 86400000);
      return { name: name, recency: recencyDays, frequency: c.count, monetary: c.total };
    });
    const calculateScore = (val, thresholds) => {
      if (val <= thresholds[0]) return 5;
      if (val <= thresholds[1]) return 4;
      if (val <= thresholds[2]) return 3;
      if (val <= thresholds[3]) return 2;
      return 1;
    };
    customers.forEach(c => {
      c.rScore = calculateScore(c.recency, [7, 14, 30, 60]);
      c.fScore = calculateScore(-c.frequency, [-10, -5, -3, -1]);
      c.mScore = calculateScore(-c.monetary, [-5000, -2000, -1000, -300]);
      c.rfmScore = c.rScore + c.fScore + c.mScore;
    });
    const segments = {
      champion: customers.filter(c => c.rfmScore >= 12),
      loyal: customers.filter(c => c.rfmScore >= 9 && c.rfmScore < 12),
      potential: customers.filter(c => c.rfmScore >= 6 && c.rfmScore < 9),
      atRisk: customers.filter(c => c.rfmScore >= 4 && c.rfmScore < 6),
      lost: customers.filter(c => c.rfmScore < 4)
    };
    const totalCustomers = customers.length;
    const totalMonetary = customers.reduce((s, c) => s + c.monetary, 0);
    const avgCLV = totalCustomers > 0 ? totalMonetary / totalCustomers : 0;
    const avgFrequency = totalCustomers > 0 ? customers.reduce((s, c) => s + c.frequency, 0) / totalCustomers : 0;
    const avgRecency = totalCustomers > 0 ? customers.reduce((s, c) => s + c.recency, 0) / totalCustomers : 0;
    const segmentRow = (label, arr, color, emoji) => ({
      type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: emoji + ' ' + label, size: 'xs', color: color, flex: 5, weight: 'bold' },
        { type: 'text', text: arr.length + ' คน (' + (totalCustomers > 0 ? ((arr.length / totalCustomers) * 100).toFixed(0) : 0) + '%)', size: 'xs', color: color, align: 'end', flex: 4, weight: 'bold' }
      ], margin: 'sm'
    });
    const topCustomers = customers.sort((a, b) => b.rfmScore - a.rfmScore || b.monetary - a.monetary).slice(0, 5);
    const flexMessage = {
      type: 'flex',
      altText: '🎯 RFM Analysis — ' + totalCustomers + ' ลูกค้า',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '🎯 RFM ANALYSIS', weight: 'bold', color: '#ec4899', size: 'lg' },
            { type: 'text', text: 'Recency · Frequency · Monetary', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('👥 ลูกค้า', String(totalCustomers), '#ec4899'),
              createStatBox('💰 Avg CLV', '฿' + Math.round(avgCLV).toLocaleString(), '#10b981')
            ]},
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('📊 Avg Frequency', avgFrequency.toFixed(1) + ' บิล', '#8b5cf6'),
              createStatBox('📅 Avg Recency', Math.round(avgRecency) + ' วัน', '#f59e0b')
            ]},
            { type: 'separator', margin: 'lg' },
            createSectionTitle('👥 Customer Segments', '#ec4899'),
            { type: 'box', layout: 'vertical', contents: [
              segmentRow('Champions (9-15)', segments.champion, '#10b981', '🏆'),
              segmentRow('Loyal (7-8)', segments.loyal, '#3b82f6', '💎'),
              segmentRow('Potential (5-6)', segments.potential, '#f59e0b', '🌱'),
              segmentRow('At Risk (3-4)', segments.atRisk, '#fb923c', '⚠️'),
              segmentRow('Lost (0-2)', segments.lost, '#ef4444', '💤')
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('⭐ Top 5 VIP Customers', '#f59e0b'),
            { type: 'box', layout: 'vertical',
              contents: topCustomers.map((c, i) => ({
                type: 'box', layout: 'horizontal', contents: [
                  { type: 'text', text: ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i] + ' ' + (c.name.length > 15 ? c.name.substring(0, 15) + '...' : c.name), size: 'xs', color: '#e5e7eb', flex: 5, wrap: true },
                  { type: 'text', text: '฿' + Math.round(c.monetary).toLocaleString(), size: 'xs', color: '#10b981', align: 'end', flex: 3, weight: 'bold' },
                  { type: 'text', text: 'RFM ' + c.rfmScore, size: 'xxs', color: '#a78bfa', align: 'end', flex: 2 }
                ], margin: 'sm'
              })),
              backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px'
            },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('💡 Recommendations', '#10b981'),
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '• 🏆 Champions: รักษาไว้ด้วยสิทธิพิเศษ', size: 'xs', color: '#10b981', wrap: true, margin: 'sm' },
              { type: 'text', text: '• 💎 Loyal: เสนอ Upsell / Cross-sell', size: 'xs', color: '#3b82f6', wrap: true, margin: 'xs' },
              { type: 'text', text: '• 🌱 Potential: ส่งโปรโมชั่นกระตุ้น', size: 'xs', color: '#f59e0b', wrap: true, margin: 'xs' },
              { type: 'text', text: '• ⚠️ At Risk: ติดต่อกลับด่วน', size: 'xs', color: '#fb923c', wrap: true, margin: 'xs' },
              { type: 'text', text: '• 💤 Lost: Win-back campaign', size: 'xs', color: '#ef4444', wrap: true, margin: 'xs' }
            ], backgroundColor: '#1a1f2e', paddingAll: '12px', cornerRadius: '12px' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

// ---------- 5. ABC ANALYSIS ----------
function replyABCAnalysis(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const t30 = new Date(now.getTime() - 30 * 86400000);
    const recentSales = data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= t30);
    const byProduct = {};
    recentSales.forEach(l => {
      const n = l.productName || 'ไม่ทราบ';
      if (!byProduct[n]) byProduct[n] = { rev: 0, vol: 0, rt: l.recipeType };
      byProduct[n].rev += Number(l.total || 0);
      byProduct[n].vol += Number(l.qty || 0);
    });
    const totalRev = Object.values(byProduct).reduce((s, p) => s + p.rev, 0);
    const prodSorted = Object.keys(byProduct).sort((a, b) => byProduct[b].rev - byProduct[a].rev);
    let cumRev = 0;
    const abcData = prodSorted.map((name, idx) => {
      cumRev += byProduct[name].rev;
      const cumPct = totalRev > 0 ? (cumRev / totalRev) * 100 : 0;
      const revPct = totalRev > 0 ? (byProduct[name].rev / totalRev) * 100 : 0;
      let cls, color;
      if (cumPct <= 80) { cls = 'A'; color = '#10b981'; }
      else if (cumPct <= 95) { cls = 'B'; color = '#f59e0b'; }
      else { cls = 'C'; color = '#ef4444'; }
      return { rank: idx + 1, name: name, revenue: byProduct[name].rev, volume: byProduct[name].vol, revPct: revPct, cumPct: cumPct, class: cls, color: color };
    });
    const aProducts = abcData.filter(p => p.class === 'A');
    const bProducts = abcData.filter(p => p.class === 'B');
    const cProducts = abcData.filter(p => p.class === 'C');
    const aRev = aProducts.reduce((s, p) => s + p.revenue, 0);
    const bRev = bProducts.reduce((s, p) => s + p.revenue, 0);
    const cRev = cProducts.reduce((s, p) => s + p.revenue, 0);
    const classRow = (cls, label, products, revenue, total, color, emoji) => ({
      type: 'box', layout: 'vertical', contents: [
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: emoji + ' Class ' + cls + ' - ' + label, size: 'sm', color: color, flex: 5, weight: 'bold' },
          { type: 'text', text: products.length + ' รายการ', size: 'sm', color: color, align: 'end', flex: 3, weight: 'bold' }
        ] },
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: 'รายได้ ฿' + Math.round(revenue).toLocaleString(), size: 'xs', color: '#9ca3af', flex: 5 },
          { type: 'text', text: (total > 0 ? ((revenue / total) * 100).toFixed(1) : 0) + '%', size: 'xs', color: color, align: 'end', flex: 3 }
        ], margin: 'xs' }
      ],
      backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '10px', margin: 'sm'
    });
    const topRows = abcData.slice(0, 8).map(p => ({
      type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: '#' + p.rank, size: 'xxs', color: '#6b7280', flex: 1 },
        { type: 'text', text: p.name.length > 14 ? p.name.substring(0, 14) + '...' : p.name, size: 'xs', color: '#e5e7eb', flex: 5, wrap: true },
        { type: 'text', text: p.class, size: 'xs', color: p.color, align: 'center', flex: 1, weight: 'bold' },
        { type: 'text', text: '฿' + Math.round(p.revenue).toLocaleString(), size: 'xs', color: '#10b981', align: 'end', flex: 3, weight: 'bold' }
      ], margin: 'sm'
    }));
    const flexMessage = {
      type: 'flex',
      altText: '🥇 ABC Analysis (Pareto)',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '🥇 ABC ANALYSIS', weight: 'bold', color: '#10b981', size: 'lg' },
            { type: 'text', text: 'Pareto 80/20 · 30 วันล่าสุด', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('📊 สินค้า', String(abcData.length), '#8b5cf6'),
              createStatBox('💰 รายได้', '฿' + Math.round(totalRev).toLocaleString(), '#10b981')
            ]},
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📊 Classification', '#10b981'),
            classRow('A', '80% แรกของรายได้', aProducts, aRev, totalRev, '#10b981', '🥇'),
            classRow('B', '15% ถัดไป', bProducts, bRev, totalRev, '#f59e0b', '🥈'),
            classRow('C', '5% ที่เหลือ', cProducts, cRev, totalRev, '#ef4444', '🥉'),
            { type: 'separator', margin: 'lg' },
            createSectionTitle('🏆 Top 8 สินค้า', '#3b82f6'),
            { type: 'box', layout: 'vertical', contents: topRows, backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('💡 Recommendations', '#ec4899'),
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '• Class A (' + aProducts.length + ' รายการ): เน้นสต๊อก + การตลาด', size: 'xs', color: '#10b981', wrap: true, margin: 'sm' },
              { type: 'text', text: '• Class B (' + bProducts.length + ' รายการ): เพิ่มยอดขาย Upsell', size: 'xs', color: '#f59e0b', wrap: true, margin: 'xs' },
              { type: 'text', text: '• Class C (' + cProducts.length + ' รายการ): พิจารณาตัด/โปรโมชั่น', size: 'xs', color: '#ef4444', wrap: true, margin: 'xs' }
            ], backgroundColor: '#1a1f2e', paddingAll: '12px', cornerRadius: '12px' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

// ---------- 6. SEASONAL ANALYSIS ----------
function replySeasonalAnalysis(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const monthlyData = [];
    for (let i = 11; i >= 0; i--) {
      const mStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const sales = salesLogs.filter(l => { const d = new Date(l.timestamp); return d >= mStart && d < mEnd; });
      monthlyData.push({
        month: ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'][mStart.getMonth()],
        year: mStart.getFullYear() + 543,
        revenue: sales.reduce((s, l) => s + Number(l.total || 0), 0),
        volume: sales.reduce((s, l) => s + Number(l.qty || 0), 0)
      });
    }
    const maxRev = Math.max.apply(null, monthlyData.map(m => m.revenue)) || 1;
    const monthRows = monthlyData.map(m => {
      const barLen = Math.round((m.revenue / maxRev) * 15);
      const bar = '█'.repeat(barLen);
      return {
        type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: m.month + ' ' + String(m.year).slice(-2), size: 'xxs', color: '#9ca3af', flex: 3 },
          { type: 'text', text: bar, size: 'xs', color: m.revenue === maxRev ? '#f59e0b' : '#3b82f6', flex: 5 },
          { type: 'text', text: '฿' + (m.revenue / 1000).toFixed(0) + 'K', size: 'xxs', color: m.revenue === maxRev ? '#f59e0b' : '#10b981', align: 'end', flex: 2, weight: 'bold' }
        ], margin: 'sm'
      };
    });
    const dayNames = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
    const dayRev = [0, 0, 0, 0, 0, 0, 0];
    salesLogs.forEach(l => { dayRev[new Date(l.timestamp).getDay()] += Number(l.total || 0); });
    const maxDayRev = Math.max.apply(null, dayRev) || 1;
    const dayRows = dayRev.map((v, i) => {
      const barLen = Math.round((v / maxDayRev) * 15);
      const bar = '█'.repeat(barLen);
      return {
        type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: dayNames[i], size: 'xs', color: '#9ca3af', flex: 1 },
          { type: 'text', text: bar, size: 'xs', color: v === maxDayRev ? '#f59e0b' : '#8b5cf6', flex: 5 },
          { type: 'text', text: '฿' + Math.round(v / 1000) + 'K', size: 'xxs', color: v === maxDayRev ? '#f59e0b' : '#10b981', align: 'end', flex: 2, weight: 'bold' }
        ], margin: 'xs'
      };
    });
    const hourBuckets = new Array(4).fill(0);
    salesLogs.forEach(l => { hourBuckets[Math.floor(new Date(l.timestamp).getHours() / 6)] += Number(l.total || 0); });
    const maxHour = Math.max.apply(null, hourBuckets) || 1;
    const hourLabels = ['00-06', '06-12', '12-18', '18-24'];
    const hourRows = hourBuckets.map((v, i) => {
      const barLen = Math.round((v / maxHour) * 15);
      const bar = '█'.repeat(barLen);
      return {
        type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: hourLabels[i], size: 'xs', color: '#9ca3af', flex: 2 },
          { type: 'text', text: bar, size: 'xs', color: v === maxHour ? '#f59e0b' : '#06b6d4', flex: 4 },
          { type: 'text', text: '฿' + Math.round(v / 1000) + 'K', size: 'xxs', color: v === maxHour ? '#f59e0b' : '#10b981', align: 'end', flex: 2, weight: 'bold' }
        ], margin: 'xs'
      };
    });
    const bestMonth = monthlyData.reduce((best, m) => m.revenue > best.revenue ? m : best, monthlyData[0]);
    const bestDay = dayRev.indexOf(maxDayRev);
    const flexMessage = {
      type: 'flex',
      altText: '📅 Seasonal Analysis',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '📅 SEASONAL ANALYSIS', weight: 'bold', color: '#f59e0b', size: 'lg' },
            { type: 'text', text: 'วิเคราะห์ตามฤดูกาล · 12 เดือนล่าสุด', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            createSectionTitle('📆 ยอดขายรายเดือน (12 เดือน)', '#f59e0b'),
            { type: 'box', layout: 'vertical', contents: monthRows, backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'box', layout: 'horizontal', contents: [
              { type: 'text', text: '🏆 เดือนที่ดีที่สุด', size: 'xs', color: '#9ca3af', flex: 5 },
              { type: 'text', text: bestMonth.month + ' ' + String(bestMonth.year).slice(-2) + ' · ฿' + Math.round(bestMonth.revenue).toLocaleString(), size: 'xs', color: '#f59e0b', align: 'end', flex: 5, weight: 'bold' }
            ], margin: 'sm' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📅 ยอดขายตามวัน', '#8b5cf6'),
            { type: 'box', layout: 'vertical', contents: dayRows, backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'box', layout: 'horizontal', contents: [
              { type: 'text', text: '🏆 วันที่ดีที่สุด', size: 'xs', color: '#9ca3af', flex: 5 },
              { type: 'text', text: dayNames[bestDay] + ' · ฿' + Math.round(maxDayRev).toLocaleString(), size: 'xs', color: '#a78bfa', align: 'end', flex: 5, weight: 'bold' }
            ], margin: 'sm' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('⏰ ยอดขายตามช่วงเวลา', '#06b6d4'),
            { type: 'box', layout: 'vertical', contents: hourRows, backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

// ---------- 7. BASKET ANALYSIS ----------
function replyBasketAnalysis(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const t30 = new Date(now.getTime() - 30 * 86400000);
    const recentSales = data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= t30);
    const bills = {};
    recentSales.forEach(l => {
      const key = new Date(l.timestamp).toISOString().slice(0, 16) + '_' + (l.note || '');
      if (!bills[key]) bills[key] = new Set();
      bills[key].add(l.productName);
    });
    const multiItemBills = Object.values(bills).filter(set => set.size >= 2);
    const pairCount = {};
    multiItemBills.forEach(set => {
      const items = Array.from(set);
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const pair = [items[i], items[j]].sort().join(' + ');
          pairCount[pair] = (pairCount[pair] || 0) + 1;
        }
      }
    });
    const topPairs = Object.keys(pairCount).sort((a, b) => pairCount[b] - pairCount[a]).slice(0, 8);
    const productFreq = {};
    recentSales.forEach(l => { productFreq[l.productName] = (productFreq[l.productName] || 0) + 1; });
    const topProducts = Object.keys(productFreq).sort((a, b) => productFreq[b] - productFreq[a]).slice(0, 5);
    const pairRows = topPairs.map((pair, i) => ({
      type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣'][i] + ' ' + pair, size: 'xs', color: '#e5e7eb', flex: 5, wrap: true },
        { type: 'text', text: pairCount[pair] + ' ครั้ง', size: 'xs', color: '#10b981', align: 'end', flex: 2, weight: 'bold' },
        { type: 'text', text: (multiItemBills.length > 0 ? ((pairCount[pair] / multiItemBills.length) * 100).toFixed(0) : 0) + '%', size: 'xxs', color: '#a78bfa', align: 'end', flex: 1 }
      ], margin: 'sm'
    }));
    const flexMessage = {
      type: 'flex',
      altText: '🛒 Basket Analysis',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '🛒 BASKET ANALYSIS', weight: 'bold', color: '#8b5cf6', size: 'lg' },
            { type: 'text', text: 'Market Basket · 30 วันล่าสุด', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('🧾 บิลทั้งหมด', String(Object.keys(bills).length), '#8b5cf6'),
              createStatBox('🛒 2+ รายการ', String(multiItemBills.length), '#10b981')
            ]},
            { type: 'separator', margin: 'lg' },
            createSectionTitle('🔗 คู่สินค้าที่ซื้อบ่อย', '#8b5cf6'),
            { type: 'box', layout: 'vertical', contents: pairRows.length > 0 ? pairRows : [{ type: 'text', text: 'ไม่มีบิลที่มี 2+ รายการ', color: '#6b7280', size: 'xs', margin: 'sm', align: 'center' }], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('🏆 สินค้าขายดี Top 5', '#10b981'),
            { type: 'box', layout: 'vertical',
              contents: topProducts.map((name, i) => ({
                type: 'box', layout: 'horizontal', contents: [
                  { type: 'text', text: ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i] + ' ' + name, size: 'xs', color: '#e5e7eb', flex: 6, wrap: true },
                  { type: 'text', text: productFreq[name] + ' ครั้ง', size: 'xs', color: '#10b981', align: 'end', flex: 3, weight: 'bold' }
                ], margin: 'sm'
              })),
              backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px'
            },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('💡 Cross-sell Tips', '#ec4899'),
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: topPairs.length > 0 ? '• 💡 แนะนำ "' + topPairs[0] + '" เป็น Bundle' : '• ยังไม่มีคู่สินค้าที่แนะนำ', size: 'xs', color: '#d1d5db', wrap: true, margin: 'sm' },
              { type: 'text', text: '• 📢 โปรโมทคู่ที่ซื้อบ่อยเป็น Set', size: 'xs', color: '#d1d5db', wrap: true, margin: 'xs' }
            ], backgroundColor: '#1a1f2e', paddingAll: '12px', cornerRadius: '12px' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

// ---------- 8. COHORT ANALYSIS ----------
function replyCohortAnalysis(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const byCustomer = {};
    salesLogs.forEach(l => {
      if (l.note && l.note.trim() && l.note.length < 50) {
        const c = l.note.trim();
        if (!byCustomer[c]) byCustomer[c] = { firstDate: Infinity, bills: [], total: 0 };
        const d = new Date(l.timestamp);
        if (d.getTime() < byCustomer[c].firstDate) byCustomer[c].firstDate = d.getTime();
        byCustomer[c].bills.push({ date: d, total: Number(l.total || 0) });
        byCustomer[c].total += Number(l.total || 0);
      }
    });
    const totalCustomers = Object.keys(byCustomer).length;
    const totalRevenue = Object.values(byCustomer).reduce((s, c) => s + c.total, 0);
    const avgCLV = totalCustomers > 0 ? totalRevenue / totalCustomers : 0;
    let returning = 0;
    Object.values(byCustomer).forEach(c => { if (c.bills.length >= 2) returning++; });
    const retentionRate = totalCustomers > 0 ? (returning / totalCustomers) * 100 : 0;
    const flexMessage = {
      type: 'flex',
      altText: '📈 Cohort Analysis',
      contents: {
        type: 'bubble', size: 'giga',
        header: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'text', text: '📈 COHORT ANALYSIS', weight: 'bold', color: '#10b981', size: 'lg' },
            { type: 'text', text: 'การกลับมาซื้อซ้ำ', color: '#9ca3af', size: 'xs', margin: 'sm' }
          ],
          backgroundColor: '#0a0c10', paddingAll: '16px'
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('👥 ลูกค้า', String(totalCustomers), '#10b981'),
              createStatBox('💰 Avg CLV', '฿' + Math.round(avgCLV).toLocaleString(), '#8b5cf6')
            ]},
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('🔄 Retention Rate', retentionRate.toFixed(1) + '%', retentionRate >= 30 ? '#10b981' : retentionRate >= 15 ? '#f59e0b' : '#ef4444'),
              createStatBox('🎯 Repeat', String(returning) + ' คน', '#3b82f6')
            ]},
            { type: 'separator', margin: 'lg' },
            createSectionTitle('💡 Insights', '#ec4899'),
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '• Retention ' + retentionRate.toFixed(0) + '% - ' + (retentionRate >= 30 ? '✅ ดี' : retentionRate >= 15 ? '🟡 ปานกลาง' : '⚠️ ควรปรับปรุง'), size: 'xs', color: retentionRate >= 30 ? '#10b981' : retentionRate >= 15 ? '#f59e0b' : '#ef4444', wrap: true, margin: 'sm' },
              { type: 'text', text: '• CLV ฿' + Math.round(avgCLV).toLocaleString() + ' ต่อลูกค้า', size: 'xs', color: '#d1d5db', wrap: true, margin: 'xs' },
              { type: 'text', text: '• ' + (retentionRate < 30 ? '🎯 เพิ่มการตลาดกับลูกค้าเก่า' : '🚀 ลูกค้ากลับมาซื้อซ้ำดี'), size: 'xs', color: '#d1d5db', wrap: true, margin: 'xs' }
            ], backgroundColor: '#1a1f2e', paddingAll: '12px', cornerRadius: '12px' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

// ---------- 9-14. Additional Advanced KPIs ----------
function replyCLV(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    if (salesLogs.length === 0) return replyText(replyToken, '❌ ไม่มีข้อมูล');
    const customers = {};
    salesLogs.forEach(l => {
      const key = (l.note && l.note.trim()) ? l.note.trim() : 'ลูกค้าทั่วไป';
      if (!customers[key]) customers[key] = { first: Infinity, last: 0, count: 0, total: 0 };
      const ts = new Date(l.timestamp).getTime();
      if (ts < customers[key].first) customers[key].first = ts;
      if (ts > customers[key].last) customers[key].last = ts;
      customers[key].count++;
      customers[key].total += _n(l.total);
    });
    const keys = Object.keys(customers);
    let totalCLV = 0, totalLifespan = 0, totalAOV = 0, totalFreq = 0;
    const clvRows = keys.map(k => {
      const c = customers[k];
      const lifespanDays = Math.max(1, (c.last - c.first) / 86400000);
      const lifespanMonths = Math.max(1, lifespanDays / 30);
      const freq = c.count / lifespanMonths;
      const aov = c.total / c.count;
      const clv = aov * freq * lifespanMonths;
      totalCLV += clv; totalLifespan += lifespanMonths; totalAOV += aov; totalFreq += freq;
      return { name: k, clv: clv, total: c.total };
    }).sort((a, b) => b.clv - a.clv);
    const avgCLV = totalCLV / keys.length;
    const top10 = clvRows.slice(0, 10);
    const flexMessage = {
      type: 'flex', altText: 'Customer Lifetime Value',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '💎 CUSTOMER LIFETIME VALUE', weight: 'bold', color: '#8b5cf6', size: 'lg' },
          { type: 'text', text: 'มูลค่าตลอดชีพของลูกค้า', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: 'Average CLV', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: _fmtK(avgCLV), color: '#8b5cf6', size: 'xxl', weight: 'bold' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('Lifespan', (totalLifespan / keys.length).toFixed(1) + ' เดือน', '#3b82f6'),
              createStatBox('AOV', _fmtK(totalAOV / keys.length), '#10b981')
            ]},
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('Frequency', (totalFreq / keys.length).toFixed(2) + '/เดือน', '#f59e0b'),
              createStatBox('ลูกค้า', keys.length + ' ราย', '#06b6d4')
            ]},
            { type: 'separator', margin: 'lg' },
            createSectionTitle('🏆 Top 10 CLV', '#8b5cf6')
          ].concat(top10.map((c, i) => ({
            type: 'box', layout: 'horizontal', margin: 'sm', contents: [
              { type: 'text', text: ['🥇', '🥈', '🥉'][i] || '#' + (i + 1) + ' ' + (c.name.length > 15 ? c.name.substring(0, 15) + '...' : c.name), size: 'xs', color: '#e5e7eb', flex: 5, wrap: true },
              { type: 'text', text: _fmtK(c.clv), size: 'xs', color: '#8b5cf6', align: 'end', flex: 3, weight: 'bold' }
            ]
          }))),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyChurn(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const customers = {};
    salesLogs.forEach(l => {
      const key = (l.note && l.note.trim()) ? l.note.trim() : 'ลูกค้าทั่วไป';
      if (!customers[key]) customers[key] = { lastDate: 0 };
      const ts = new Date(l.timestamp).getTime();
      if (ts > customers[key].lastDate) customers[key].lastDate = ts;
    });
    const now = Date.now();
    const total = Object.keys(customers).length;
    const active30 = Object.values(customers).filter(c => (now - c.lastDate) <= 30 * 86400000).length;
    const active60 = Object.values(customers).filter(c => (now - c.lastDate) <= 60 * 86400000).length;
    const churn30Rate = total > 0 ? ((total - active30) / total) * 100 : 0;
    const color = churn30Rate > 50 ? '#ef4444' : churn30Rate > 30 ? '#f59e0b' : '#10b981';
    const flexMessage = {
      type: 'flex', altText: 'Churn Rate Analysis',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📉 CHURN RATE', weight: 'bold', color: '#ef4444', size: 'xl' },
          { type: 'text', text: 'อัตราการสูญเสียลูกค้า', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '🔴 Churn Rate 30 วัน', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: churn30Rate.toFixed(1) + '%', color: color, size: 'xxl', weight: 'bold' },
              { type: 'text', text: 'ลูกค้าหาย ' + (total - active30) + ' จาก ' + total + ' ราย', color: '#9ca3af', size: 'sm', margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📊 Active Customers', '#10b981'),
            createAnalysisRow('Active 30 วัน', active30 + ' ราย', '#10b981'),
            createAnalysisRow('Active 60 วัน', active60 + ' ราย', '#3b82f6'),
            createAnalysisRow('Churn 30 วัน', (total - active30) + ' ราย', '#ef4444'),
            { type: 'separator', margin: 'md' },
            { type: 'text', text: '💡 ' + (churn30Rate > 50 ? '⚠️ ต้องทำแคมเปญเรียกคืนด่วน' : churn30Rate > 30 ? '🟡 ควรกระตุ้นลูกค้า' : '✅ อัตราคงที่ดี'), size: 'xs', color: color, wrap: true, margin: 'sm' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replySegment(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const customers = {};
    salesLogs.forEach(l => {
      const key = (l.note && l.note.trim()) ? l.note.trim() : 'ลูกค้าทั่วไป';
      if (!customers[key]) customers[key] = { count: 0, total: 0, lastDate: 0 };
      customers[key].count++;
      customers[key].total += _n(l.total);
      const ts = new Date(l.timestamp).getTime();
      if (ts > customers[key].lastDate) customers[key].lastDate = ts;
    });
    const keys = Object.keys(customers);
    const totals = keys.map(k => customers[k].total).sort((a, b) => a - b);
    const median = totals[Math.floor(totals.length / 2)] || 0;
    const segments = { 'VIP': [], 'Regular': [], 'Occasional': [], 'One-time': [] };
    const now = Date.now();
    keys.forEach(k => {
      const c = customers[k];
      const isVip = c.total >= median * 2;
      const isRegular = c.count >= 5;
      const recent = (now - c.lastDate) <= 30 * 86400000;
      if (isVip) segments['VIP'].push({ name: k, count: c.count, total: c.total });
      else if (isRegular && recent) segments['Regular'].push({ name: k, count: c.count, total: c.total });
      else if (c.count >= 2) segments['Occasional'].push({ name: k, count: c.count, total: c.total });
      else segments['One-time'].push({ name: k, count: c.count, total: c.total });
    });
    const segInfo = [
      { icon: '👑', label: 'VIP', color: '#10b981', list: segments['VIP'], desc: 'ซื้อมากกว่า 2× median' },
      { icon: '⭐', label: 'Regular', color: '#3b82f6', list: segments['Regular'], desc: '≥5 ครั้ง + ภายใน 30 วัน' },
      { icon: '🌟', label: 'Occasional', color: '#f59e0b', list: segments['Occasional'], desc: 'ซื้อ 2+ ครั้ง' },
      { icon: '🆕', label: 'One-time', color: '#6b7280', list: segments['One-time'], desc: 'ซื้อครั้งเดียว' }
    ];
    const flexMessage = {
      type: 'flex', altText: 'Customer Segmentation',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '🎯 CUSTOMER SEGMENTATION', weight: 'bold', color: '#8b5cf6', size: 'xl' },
          { type: 'text', text: 'แบ่งกลุ่มลูกค้าตามพฤติกรรม', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: segInfo.map(seg => {
            const totalRev = seg.list.reduce((s, c) => s + c.total, 0);
            return { type: 'box', layout: 'vertical', contents: [
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: seg.icon + ' ' + seg.label, size: 'sm', color: seg.color, weight: 'bold', flex: 4 },
                { type: 'text', text: seg.list.length + ' ราย', size: 'sm', color: seg.color, align: 'end', flex: 2, weight: 'bold' }
              ]},
              { type: 'text', text: seg.desc, size: 'xxs', color: '#6b7280', margin: 'xs' },
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: 'รายได้รวม', size: 'xs', color: '#9ca3af', flex: 3 },
                { type: 'text', text: _fmtK(totalRev), size: 'xs', color: '#10b981', align: 'end', flex: 3, weight: 'bold' }
              ], margin: 'xs' }
            ], backgroundColor: '#0f1419', paddingAll: '10px', cornerRadius: '10px', margin: 'sm' };
          }),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyAOVTrend(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const monthly = {};
    salesLogs.forEach(l => {
      const d = new Date(l.timestamp);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      if (!monthly[key]) monthly[key] = { revenue: 0, txCount: 0 };
      monthly[key].revenue += _n(l.total);
      monthly[key].txCount++;
    });
    const months = Object.keys(monthly).sort().slice(-6);
    const rows = months.map(m => {
      const v = monthly[m];
      return { month: m, aov: v.txCount > 0 ? v.revenue / v.txCount : 0 };
    });
    const avgAOV = rows.reduce((s, r) => s + r.aov, 0) / rows.length;
    const trendUp = rows.length >= 2 && rows[rows.length - 1].aov > rows[0].aov;
    const flexMessage = {
      type: 'flex', altText: 'AOV Trend',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '💰 AOV TREND', weight: 'bold', color: '#f59e0b', size: 'xl' },
          { type: 'text', text: 'Average Order Value รายเดือน', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: 'AOV เฉลี่ย', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: _fmtK(avgAOV), color: '#f59e0b', size: 'xxl', weight: 'bold' },
              { type: 'text', text: trendUp ? '📈 แนวโน้มเพิ่มขึ้น' : '📉 แนวโน้มลดลง', color: trendUp ? '#10b981' : '#ef4444', size: 'sm', margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📅 รายเดือน', '#f59e0b')
          ].concat(rows.map(r => createAnalysisRow(r.month, _fmtK(r.aov), r.aov >= avgAOV ? '#10b981' : '#ef4444'))),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyPnL(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthLogs = data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= monthStart);
    const monthExps = data.expenses.filter(e => new Date(e.timestamp) >= monthStart);
    const revenue = monthLogs.reduce((s, l) => s + _n(l.total), 0);
    const volume = monthLogs.reduce((s, l) => s + _n(l.qty), 0);
    let cogs = 0;
    monthLogs.forEach(l => { cogs += _n(l.qty) * getUnitCostFromConfig(l.recipeType || 'RED'); });
    const grossProfit = revenue - cogs;
    const expByCat = {};
    monthExps.forEach(e => { expByCat[e.category] = (expByCat[e.category] || 0) + _n(e.amount); });
    const catLabels = { LEAVES: '🍃 ใบกระท่อม', COKE: '🥤 โค้ก', SYRUP_RED: '🧪 ยาแดง', SYRUP_BM: '🧪 ยา BM', BOTTLE: '🍾 ขวด', GAS: '🔥 แก๊ส', PLUM: '🫐 บ๊วย', OTHER: '📦 อื่นๆ' };
    const totalExp = Object.values(expByCat).reduce((a, b) => a + b, 0);
    const netProfit = grossProfit - totalExp;
    const gm = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
    const nm = revenue > 0 ? (netProfit / revenue) * 100 : 0;
    const expRows = Object.keys(expByCat).sort((a, b) => expByCat[b] - expByCat[a]).map(cat => createAnalysisRow(catLabels[cat] || cat, '-' + _fmtK(expByCat[cat]), '#ef4444'));
    const flexMessage = {
      type: 'flex', altText: 'Profit & Loss Statement',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📊 PROFIT & LOSS', weight: 'bold', color: '#10b981', size: 'xl' },
          { type: 'text', text: 'งบกำไรขาดทุน · ' + formatThaiDateShort(now), color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'sm',
          contents: [
            { type: 'box', layout: 'horizontal', contents: [
              { type: 'text', text: '💰 รายได้', size: 'sm', color: '#e5e7eb', weight: 'bold', flex: 3 },
              { type: 'text', text: _fmtK(revenue), size: 'sm', color: '#10b981', align: 'end', flex: 3, weight: 'bold' }
            ]},
            createAnalysisRow('   📦 ' + volume + ' ขวด', '', '#9ca3af'),
            { type: 'separator', margin: 'md' },
            { type: 'box', layout: 'horizontal', contents: [
              { type: 'text', text: '📉 COGS', size: 'sm', color: '#e5e7eb', flex: 3 },
              { type: 'text', text: '-' + _fmtK(cogs), size: 'sm', color: '#ef4444', align: 'end', flex: 3, weight: 'bold' }
            ]},
            { type: 'box', layout: 'horizontal', contents: [
              { type: 'text', text: '💵 กำไรขั้นต้น', size: 'sm', color: '#10b981', weight: 'bold', flex: 3 },
              { type: 'text', text: _fmtK(grossProfit), size: 'sm', color: '#10b981', align: 'end', flex: 3, weight: 'bold' }
            ], backgroundColor: '#0f1419', paddingAll: '6px', cornerRadius: '6px', margin: 'sm' },
            createAnalysisRow('   GM%', gm.toFixed(1) + '%', '#10b981'),
            { type: 'separator', margin: 'md' },
            createSectionTitle('💸 Operating Expenses', '#f59e0b')
          ].concat(expRows).concat([
            { type: 'box', layout: 'horizontal', contents: [
              { type: 'text', text: '   รวมค่าใช้จ่าย', size: 'sm', color: '#f59e0b', weight: 'bold', flex: 3 },
              { type: 'text', text: '-' + _fmtK(totalExp), size: 'sm', color: '#ef4444', align: 'end', flex: 3, weight: 'bold' }
            ], margin: 'sm' },
            { type: 'separator', margin: 'md' },
            { type: 'box', layout: 'horizontal', contents: [
              { type: 'text', text: '🎯 กำไรสุทธิ', size: 'md', color: netProfit >= 0 ? '#10b981' : '#ef4444', weight: 'bold', flex: 3 },
              { type: 'text', text: (netProfit >= 0 ? '+' : '') + _fmtK(netProfit), size: 'md', color: netProfit >= 0 ? '#10b981' : '#ef4444', align: 'end', flex: 3, weight: 'bold' }
            ], backgroundColor: '#0f1419', paddingAll: '10px', cornerRadius: '8px', margin: 'md' },
            createAnalysisRow('   NM%', nm.toFixed(1) + '%', nm >= 20 ? '#10b981' : nm >= 0 ? '#f59e0b' : '#ef4444')
          ]),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyFinancialRatios(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthLogs = data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= ms);
    const monthExps = data.expenses.filter(e => new Date(e.timestamp) >= ms);
    const revenue = monthLogs.reduce((s, l) => s + _n(l.total), 0);
    const volume = monthLogs.reduce((s, l) => s + _n(l.qty), 0);
    let cogs = 0;
    monthLogs.forEach(l => { cogs += _n(l.qty) * getUnitCostFromConfig(l.recipeType || 'RED'); });
    const grossProfit = revenue - cogs;
    const expense = monthExps.reduce((s, e) => s + _n(e.amount), 0);
    const netProfit = revenue - expense;
    const gm = _pct(grossProfit, revenue);
    const nm = _pct(netProfit, revenue);
    const opMargin = _pct(revenue - expense, revenue);
    const roi = cogs > 0 ? _pct(netProfit, cogs) : 0;
    const cashIn = monthLogs.filter(l => l.paymentMethod === 'CASH').reduce((s, l) => s + _n(l.total), 0);
    const cashOut = monthExps.filter(e => e.paymentMethod === 'CASH').reduce((s, e) => s + _n(e.amount), 0);
    const cashReserve = cashIn - cashOut;
    const cashRatio = expense > 0 ? cashReserve / expense : 0;
    const quickRatio = expense > 0 ? (cashReserve + grossProfit / 2) / expense : 0;
    const currentRatio = expense > 0 ? (cashReserve + grossProfit) / expense : 0;
    const workingCapital = cashReserve + grossProfit - expense;
    const invTurnover = cogs > 0 && volume > 0 ? cogs / (volume / 2) : 0;
    const daysInv = invTurnover > 0 ? 365 / invTurnover : 0;
    const assetTurnover = cogs > 0 ? revenue / cogs : 0;
    const revPerEmployee = revenue / Math.max(1, Math.ceil(volume / 1000));
    const flexMessage = {
      type: 'flex', altText: 'Financial Ratios',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📈 FINANCIAL RATIOS', weight: 'bold', color: '#8b5cf6', size: 'xl' },
          { type: 'text', text: 'อัตราส่วนทางการเงิน · เดือนนี้', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            createSectionTitle('💰 Profitability', '#10b981'),
            createAnalysisRow('Gross Margin', gm.toFixed(1) + '%', gm > 50 ? '#10b981' : '#f59e0b'),
            createAnalysisRow('Net Margin', nm.toFixed(1) + '%', nm > 20 ? '#10b981' : nm > 0 ? '#f59e0b' : '#ef4444'),
            createAnalysisRow('Operating Margin', opMargin.toFixed(1) + '%', opMargin > 15 ? '#10b981' : '#f59e0b'),
            createAnalysisRow('ROI', roi.toFixed(1) + '%', roi > 20 ? '#10b981' : '#f59e0b'),
            { type: 'separator', margin: 'md' },
            createSectionTitle('⚡ Efficiency', '#3b82f6'),
            createAnalysisRow('Inventory Turnover', invTurnover.toFixed(2) + 'x', invTurnover > 2 ? '#10b981' : '#f59e0b'),
            createAnalysisRow('Days Inventory', daysInv.toFixed(0) + ' days', '#3b82f6'),
            createAnalysisRow('Asset Turnover', assetTurnover.toFixed(2) + 'x', '#3b82f6'),
            createAnalysisRow('Revenue/Employee', _fmtK(revPerEmployee), '#3b82f6'),
            { type: 'separator', margin: 'md' },
            createSectionTitle('💧 Liquidity', '#f59e0b'),
            createAnalysisRow('Cash Ratio', cashRatio.toFixed(2) + 'x', cashRatio > 1 ? '#10b981' : '#ef4444'),
            createAnalysisRow('Quick Ratio', quickRatio.toFixed(2) + 'x', quickRatio > 1.5 ? '#10b981' : '#f59e0b'),
            createAnalysisRow('Current Ratio', currentRatio.toFixed(2) + 'x', currentRatio > 2 ? '#10b981' : '#f59e0b'),
            createAnalysisRow('Working Capital', _fmtK(workingCapital), workingCapital > 0 ? '#10b981' : '#ef4444')
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyBreakEven(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthLogs = data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= ms);
    const monthExps = data.expenses.filter(e => new Date(e.timestamp) >= ms);
    const revenue = monthLogs.reduce((s, l) => s + _n(l.total), 0);
    const volume = monthLogs.reduce((s, l) => s + _n(l.qty), 0);
    let cogs = 0;
    monthLogs.forEach(l => { cogs += _n(l.qty) * getUnitCostFromConfig(l.recipeType || 'RED'); });
    const expense = monthExps.reduce((s, e) => s + _n(e.amount), 0);
    const avgPrice = volume > 0 ? revenue / volume : 35;
    const avgCost = volume > 0 ? cogs / volume : 15;
    const cm = avgPrice - avgCost;
    const fixedCost = Math.max(0, expense - cogs);
    const beUnits = cm > 0 ? Math.ceil(fixedCost / cm) : 0;
    const beRevenue = beUnits * avgPrice;
    const mos = revenue > 0 && beRevenue > 0 ? Math.max(0, ((revenue - beRevenue) / revenue) * 100) : 0;
    const mosColor = mos > 30 ? '#10b981' : mos > 10 ? '#f59e0b' : '#ef4444';
    const flexMessage = {
      type: 'flex', altText: 'Break-Even Analysis',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '⚖️ BREAK-EVEN ANALYSIS', weight: 'bold', color: '#8b5cf6', size: 'xl' },
          { type: 'text', text: 'จุดคุ้มทุน · เดือนนี้', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '🎯 Break-Even Point', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: beUnits.toLocaleString() + ' ขวด', color: '#8b5cf6', size: 'xxl', weight: 'bold' },
              { type: 'text', text: '≈ ' + _fmtK(beRevenue), color: '#f59e0b', size: 'sm', margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📊 Margin of Safety', mosColor),
            createAnalysisRow('ขายจริง', _fmtK(revenue), '#10b981'),
            createAnalysisRow('จุดคุ้มทุน', _fmtK(beRevenue), '#ef4444'),
            createAnalysisRow('Margin', mos.toFixed(1) + '%', mosColor),
            { type: 'separator', margin: 'lg' },
            createSectionTitle('💡 ตัวเลขสำคัญ', '#06b6d4'),
            createAnalysisRow('Contribution Margin', _fmtK(cm), '#10b981'),
            createAnalysisRow('Fixed Cost', _fmtK(fixedCost), '#ef4444'),
            createAnalysisRow('ราคาเฉลี่ย/ขวด', _fmtK(avgPrice), '#3b82f6'),
            createAnalysisRow('ต้นทุนผันแปร/ขวด', _fmtK(avgCost), '#f59e0b')
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replySensitivity(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthLogs = data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= ms);
    const monthExps = data.expenses.filter(e => new Date(e.timestamp) >= ms);
    const revenue = monthLogs.reduce((s, l) => s + _n(l.total), 0);
    const volume = monthLogs.reduce((s, l) => s + _n(l.qty), 0);
    let cogs = 0;
    monthLogs.forEach(l => { cogs += _n(l.qty) * getUnitCostFromConfig(l.recipeType || 'RED'); });
    const expense = monthExps.reduce((s, e) => s + _n(e.amount), 0);
    const basePrice = volume > 0 ? revenue / volume : 35;
    const baseCost = volume > 0 ? cogs / volume : 15;
    const scenarios = [-20, -10, 0, 10, 20];
    const results = [];
    scenarios.forEach(priceChange => {
      scenarios.forEach(volChange => {
        const newPrice = basePrice * (1 + priceChange / 100);
        const newVol = volume * (1 + volChange / 100);
        const newRev = newPrice * newVol;
        const newCogs = baseCost * newVol;
        const newProfit = newRev - newCogs - expense;
        results.push({ priceChange, volChange, profit: newProfit });
      });
    });
    const best = results.reduce((a, b) => a.profit > b.profit ? a : b);
    const worst = results.reduce((a, b) => a.profit < b.profit ? a : b);
    const flexMessage = {
      type: 'flex', altText: 'Sensitivity Analysis',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '🎚️ SENSITIVITY ANALYSIS', weight: 'bold', color: '#f59e0b', size: 'xl' },
          { type: 'text', text: 'What-If: ราคา × ปริมาณ', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              { type: 'box', layout: 'vertical', flex: 1, contents: [
                { type: 'text', text: '😊 Best Case', size: 'xs', color: '#10b981', weight: 'bold' },
                { type: 'text', text: '+' + best.priceChange + '% ราคา / +' + best.volChange + '% ปริมาณ', size: 'xxs', color: '#9ca3af', wrap: true },
                { type: 'text', text: _fmtK(best.profit), size: 'md', color: '#10b981', weight: 'bold', margin: 'xs' }
              ], backgroundColor: '#0f1419', paddingAll: '10px', cornerRadius: '10px' },
              { type: 'box', layout: 'vertical', flex: 1, contents: [
                { type: 'text', text: '😰 Worst Case', size: 'xs', color: '#ef4444', weight: 'bold' },
                { type: 'text', text: worst.priceChange + '% ราคา / ' + worst.volChange + '% ปริมาณ', size: 'xxs', color: '#9ca3af', wrap: true },
                { type: 'text', text: _fmtK(worst.profit), size: 'md', color: '#ef4444', weight: 'bold', margin: 'xs' }
              ], backgroundColor: '#0f1419', paddingAll: '10px', cornerRadius: '10px' }
            ]},
            { type: 'text', text: '💡 ใช้หน้า Dashboard เพื่อดู interactive slider', size: 'xxs', color: '#6b7280', wrap: true, margin: 'md' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyBurnRate(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const t30 = new Date(now.getTime() - 30 * 86400000);
    const exps = data.expenses.filter(e => new Date(e.timestamp) >= t30);
    const total = exps.reduce((s, e) => s + _n(e.amount), 0);
    const burnPerDay = total / 30;
    const byCat = {};
    exps.forEach(e => { byCat[e.category] = (byCat[e.category] || 0) + _n(e.amount); });
    const catLabels = { LEAVES: '🍃 ใบ', COKE: '🥤 โค้ก', SYRUP_RED: '🧪 ยาแดง', SYRUP_BM: '🧪 ยา BM', BOTTLE: '🍾 ขวด', GAS: '🔥 แก๊ส', PLUM: '🫐 บ๊วย', OTHER: '📦 อื่น' };
    const flexMessage = {
      type: 'flex', altText: 'Burn Rate',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '🔥 BURN RATE', weight: 'bold', color: '#ef4444', size: 'xl' },
          { type: 'text', text: 'อัตราการใช้จ่าย 30 วัน', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: 'รายจ่าย/วัน', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: _fmtK(burnPerDay), color: '#ef4444', size: 'xxl', weight: 'bold' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📊 รายจ่ายตามหมวด', '#f59e0b')
          ].concat(Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]).map(cat => createAnalysisRow(catLabels[cat] || cat, _fmtK(byCat[cat]), '#ef4444'))),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyRunway(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthLogs = data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= ms);
    const monthExps = data.expenses.filter(e => new Date(e.timestamp) >= ms);
    const cashIn = monthLogs.filter(l => l.paymentMethod === 'CASH').reduce((s, l) => s + _n(l.total), 0);
    const cashOut = monthExps.filter(e => e.paymentMethod === 'CASH').reduce((s, e) => s + _n(e.amount), 0);
    const bankIn = monthLogs.filter(l => l.paymentMethod === 'TRANSFER').reduce((s, l) => s + _n(l.total), 0);
    const bankOut = monthExps.filter(e => e.paymentMethod === 'TRANSFER').reduce((s, e) => s + _n(e.amount), 0);
    const cashBalance = cashIn - cashOut + bankIn - bankOut;
    const t30 = new Date(now.getTime() - 30 * 86400000);
    const recentExps = data.expenses.filter(e => new Date(e.timestamp) >= t30);
    const totalBurn = recentExps.reduce((s, e) => s + _n(e.amount), 0);
    const dailyBurn = totalBurn / 30;
    const runway = dailyBurn > 0 ? Math.floor(cashBalance / dailyBurn) : 999;
    const runwayColor = runway > 90 ? '#10b981' : runway > 30 ? '#f59e0b' : '#ef4444';
    const flexMessage = {
      type: 'flex', altText: 'Cash Runway',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '⏳ CASH RUNWAY', weight: 'bold', color: '#8b5cf6', size: 'xl' },
          { type: 'text', text: 'ระยะเวลาเงินสดที่ใช้ได้', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '🏦 Cash Balance', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: _fmtK(cashBalance), color: '#10b981', size: 'xl', weight: 'bold' },
              { type: 'text', text: 'Runway: ' + runway + ' วัน', color: runwayColor, size: 'xxl', weight: 'bold', margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createAnalysisRow('Daily Burn', _fmtK(dailyBurn), '#ef4444'),
            createAnalysisRow('Cash In', _fmtK(cashIn + bankIn), '#10b981'),
            createAnalysisRow('Cash Out', _fmtK(cashOut + bankOut), '#ef4444'),
            { type: 'separator', margin: 'md' },
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '💡 ' + (runway > 90 ? '✅ กระแสเงินสดแข็งแรง' : runway > 30 ? '🟡 ควรวางแผนการเงิน' : '⚠️ วิกฤติ! ต้องหาเงินทุนเพิ่ม'), size: 'xs', color: runwayColor, wrap: true }
            ], backgroundColor: '#1a1f2e', paddingAll: '10px', cornerRadius: '10px', margin: 'md' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyPareto(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const t30 = new Date(now.getTime() - 30 * 86400000);
    const salesLogs = data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= t30);
    const prodMap = {};
    salesLogs.forEach(l => {
      if (!prodMap[l.productName]) prodMap[l.productName] = 0;
      prodMap[l.productName] += _n(l.total);
    });
    const total = Object.values(prodMap).reduce((a, b) => a + b, 0);
    const sorted = Object.keys(prodMap).map(k => ({ name: k, revenue: prodMap[k] })).sort((a, b) => b.revenue - a.revenue);
    let cum = 0;
    const rows = sorted.map((p, i) => {
      cum += p.revenue;
      return { rank: i + 1, name: p.name, revenue: p.revenue, cumPct: total > 0 ? (cum / total) * 100 : 0 };
    });
    const pareto80 = rows.findIndex(r => r.cumPct >= 80) + 1;
    const flexMessage = {
      type: 'flex', altText: 'Pareto Analysis',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📊 PARETO ANALYSIS', weight: 'bold', color: '#f59e0b', size: 'xl' },
          { type: 'text', text: '80/20 Rule · 30 วัน', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '🎯 80% ของรายได้มาจาก', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: pareto80 + ' จาก ' + rows.length + ' สินค้า', color: '#f59e0b', size: 'xxl', weight: 'bold' },
              { type: 'text', text: '(' + _pct(pareto80, rows.length).toFixed(0) + '% ของสินค้าทั้งหมด)', color: '#9ca3af', size: 'sm', margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📈 ลำดับสินค้าตามรายได้', '#10b981')
          ].concat(rows.slice(0, 10).map(r => {
            const color = r.cumPct <= 80 ? '#10b981' : r.cumPct <= 95 ? '#f59e0b' : '#ef4444';
            return createAnalysisRow('#' + r.rank + ' ' + (r.name.length > 15 ? r.name.substring(0, 15) + '...' : r.name), _fmtK(r.revenue) + ' (' + r.cumPct.toFixed(0) + '%)', color);
          })),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyDeadStock(replyToken) {
  try {
    const data = getAllData();
    const products = data.products || [];
    const now = new Date();
    const t30 = new Date(now.getTime() - 30 * 86400000);
    const recentSales = data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= t30);
    const dead = products.filter(p => !recentSales.some(l => l.productName === p.name));
    if (dead.length === 0) return replyText(replyToken, '✅ ไม่มี Dead Stock\n\nสินค้าทุกตัวมียอดขายใน 30 วัน');
    const stockMap = readStockBalance();
    const flexMessage = {
      type: 'flex', altText: 'Dead Stock',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '💤 DEAD STOCK', weight: 'bold', color: '#ef4444', size: 'xl' },
          { type: 'text', text: 'สินค้าขายไม่ออก 30 วัน', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'sm',
          contents: dead.map(p => {
            const stock = stockMap[p.id] !== undefined ? stockMap[p.id] : (stockMap['name:' + p.name] || 0);
            const emoji = p.recipeType === 'RED' ? '🔴' : p.recipeType === 'BM' ? '🟡' : '⚪';
            return { type: 'box', layout: 'vertical', contents: [
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: emoji + ' ' + p.name, size: 'sm', color: '#e5e7eb', flex: 5, wrap: true, weight: 'bold' },
                { type: 'text', text: stock + ' ขวด', size: 'sm', color: '#ef4444', align: 'end', flex: 2, weight: 'bold' }
              ]},
              { type: 'text', text: 'ราคา ฿' + p.price + ' · ควรทำโปรโมชั่นหรือลดราคา', size: 'xxs', color: '#6b7280', margin: 'xs' }
            ], backgroundColor: '#0f1419', paddingAll: '10px', cornerRadius: '10px', margin: 'sm' };
          }),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyCrossSell(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const baskets = {};
    salesLogs.forEach(l => {
      const key = new Date(l.timestamp).getTime() + '_' + (l.note || '');
      if (!baskets[key]) baskets[key] = new Set();
      baskets[key].add(l.productName);
    });
    const basketList = Object.values(baskets).filter(s => s.size >= 2);
    if (basketList.length === 0) return replyText(replyToken, '❌ ยังไม่มีบิลที่มี 2+ รายการ');
    const pairs = {};
    basketList.forEach(set => {
      const items = Array.from(set);
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const key = [items[i], items[j]].sort().join(' + ');
          pairs[key] = (pairs[key] || 0) + 1;
        }
      }
    });
    const topPairs = Object.keys(pairs).sort((a, b) => pairs[b] - pairs[a]).slice(0, 8);
    const flexMessage = {
      type: 'flex', altText: 'Cross-Sell',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '🔗 CROSS-SELL', weight: 'bold', color: '#06b6d4', size: 'xl' },
          { type: 'text', text: 'สินค้าที่มักซื้อคู่กัน', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'sm',
          contents: topPairs.map((p, i) => {
            const medal = i < 3 ? ['🥇', '🥈', '🥉'][i] : '🔗';
            return createAnalysisRow(medal + ' ' + p, pairs[p] + ' ครั้ง (' + ((pairs[p] / basketList.length) * 100).toFixed(0) + '%)', '#06b6d4');
          }),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyLifecycle(replyToken) {
  try {
    const data = getAllData();
    const products = data.products || [];
    const now = new Date();
    const t30 = new Date(now.getTime() - 30 * 86400000);
    const t60 = new Date(now.getTime() - 60 * 86400000);
    const allSales = data.logs.filter(l => l.type === 'OUT');
    const lifecycle = products.map(p => {
      const recent = allSales.filter(l => l.productName === p.name && new Date(l.timestamp) >= t30);
      const prev = allSales.filter(l => { const d = new Date(l.timestamp); return l.productName === p.name && d >= t60 && d < t30; });
      const recentVol = recent.reduce((s, l) => s + _n(l.qty), 0);
      const prevVol = prev.reduce((s, l) => s + _n(l.qty), 0);
      const growth = prevVol > 0 ? ((recentVol - prevVol) / prevVol) * 100 : (recentVol > 0 ? 100 : 0);
      let stage, color, icon;
      if (recentVol === 0 && prevVol === 0) { stage = 'ยังไม่เริ่ม'; color = '#6b7280'; icon = '🌱'; }
      else if (prevVol === 0 && recentVol > 0) { stage = 'เปิดตัว'; color = '#3b82f6'; icon = '🚀'; }
      else if (growth > 20) { stage = 'เติบโต'; color = '#10b981'; icon = '📈'; }
      else if (growth < -20) { stage = 'ถดถอย'; color = '#ef4444'; icon = '📉'; }
      else { stage = 'อิ่มตัว'; color = '#f59e0b'; icon = '🏔️'; }
      return { name: p.name, stage, color, icon, recent: recentVol, prev: prevVol, growth };
    });
    const flexMessage = {
      type: 'flex', altText: 'Product Lifecycle',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '🌱 PRODUCT LIFECYCLE', weight: 'bold', color: '#10b981', size: 'xl' },
          { type: 'text', text: 'วงจรชีวิตสินค้า', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'sm',
          contents: lifecycle.map(lc => ({
            type: 'box', layout: 'vertical', contents: [
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: lc.icon + ' ' + lc.name, size: 'xs', color: '#e5e7eb', weight: 'bold', flex: 5, wrap: true },
                { type: 'text', text: lc.stage, size: 'xs', color: lc.color, align: 'end', flex: 3, weight: 'bold' }
              ]},
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: '30 วัน: ' + lc.recent, size: 'xxs', color: '#9ca3af', flex: 3 },
                { type: 'text', text: 'ก่อนหน้า: ' + lc.prev, size: 'xxs', color: '#6b7280', flex: 3 },
                { type: 'text', text: (lc.growth >= 0 ? '+' : '') + lc.growth.toFixed(0) + '%', size: 'xxs', color: lc.color, align: 'end', flex: 2, weight: 'bold' }
              ], margin: 'xs' }
            ], backgroundColor: '#0f1419', paddingAll: '10px', cornerRadius: '10px', margin: 'sm'
          })),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function _growthReply(replyToken, actionName, periodLabel, getPeriod, getPrevPeriod) {
  try {
    const data = getAllData();
    const curr = calcStats(data.logs, data.expenses, getPeriod().start, getPeriod().end);
    const prev = calcStats(data.logs, data.expenses, getPrevPeriod().start, getPrevPeriod().end);
    const revGrowth = prev.revenue > 0 ? ((curr.revenue - prev.revenue) / prev.revenue) * 100 : 0;
    const volGrowth = prev.volume > 0 ? ((curr.volume - prev.volume) / prev.volume) * 100 : 0;
    const profGrowth = prev.profit !== 0 ? ((curr.profit - prev.profit) / Math.abs(prev.profit)) * 100 : 0;
    const txGrowth = prev.txCount > 0 ? ((curr.txCount - prev.txCount) / prev.txCount) * 100 : 0;
    const flexMessage = {
      type: 'flex', altText: actionName,
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📈 ' + actionName, weight: 'bold', color: '#10b981', size: 'xl' },
          { type: 'text', text: periodLabel, color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('ปัจจุบัน', _fmtK(curr.revenue), '#10b981'),
              createStatBox('ก่อนหน้า', _fmtK(prev.revenue), '#6b7280')
            ]},
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📊 การเปลี่ยนแปลง', revGrowth >= 0 ? '#10b981' : '#ef4444'),
            createAnalysisRow('รายได้', (revGrowth >= 0 ? '+' : '') + revGrowth.toFixed(1) + '%', revGrowth >= 0 ? '#10b981' : '#ef4444'),
            createAnalysisRow('ปริมาณ', (volGrowth >= 0 ? '+' : '') + volGrowth.toFixed(1) + '%', volGrowth >= 0 ? '#10b981' : '#ef4444'),
            createAnalysisRow('กำไร', (profGrowth >= 0 ? '+' : '') + profGrowth.toFixed(1) + '%', profGrowth >= 0 ? '#10b981' : '#ef4444'),
            createAnalysisRow('บิล', (txGrowth >= 0 ? '+' : '') + txGrowth.toFixed(1) + '%', txGrowth >= 0 ? '#10b981' : '#ef4444')
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyMoM(replyToken) {
  const now = new Date();
  _growthReply(replyToken, 'MOM GROWTH', 'เดือนนี้ vs เดือนก่อน',
    () => ({ start: new Date(now.getFullYear(), now.getMonth(), 1), end: now }),
    () => ({ start: new Date(now.getFullYear(), now.getMonth() - 1, 1), end: new Date(now.getFullYear(), now.getMonth(), 1) }));
}

function replyQoQ(replyToken) {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3);
  _growthReply(replyToken, 'QOQ GROWTH', 'ไตรมาสนี้ vs ไตรมาสก่อน',
    () => ({ start: new Date(now.getFullYear(), q * 3, 1), end: now }),
    () => ({ start: new Date(now.getFullYear(), (q - 1) * 3, 1), end: new Date(now.getFullYear(), q * 3, 1) }));
}

function replyYoY(replyToken) {
  const now = new Date();
  _growthReply(replyToken, 'YOY GROWTH', 'ปีนี้ vs ปีก่อน',
    () => ({ start: new Date(now.getFullYear(), 0, 1), end: now }),
    () => ({ start: new Date(now.getFullYear() - 1, 0, 1), end: new Date(now.getFullYear() - 1, 11, 31) }));
}

function replyCAGR(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const monthly = {};
    salesLogs.forEach(l => {
      const d = new Date(l.timestamp);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      monthly[key] = (monthly[key] || 0) + _n(l.total);
    });
    const months = Object.keys(monthly).sort();
    if (months.length < 2) return replyText(replyToken, '❌ ข้อมูลไม่พอ (ต้อง≥2 เดือน)');
    const firstRev = monthly[months[0]];
    const lastRev = monthly[months[months.length - 1]];
    const years = months.length / 12;
    const cagr = firstRev > 0 && years > 0 ? (Math.pow(lastRev / firstRev, 1 / years) - 1) * 100 : 0;
    const color = cagr > 20 ? '#10b981' : cagr > 0 ? '#3b82f6' : '#ef4444';
    const flexMessage = {
      type: 'flex', altText: 'CAGR',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📊 CAGR', weight: 'bold', color: '#8b5cf6', size: 'xl' },
          { type: 'text', text: 'Compound Annual Growth Rate', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: 'CAGR', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: (cagr >= 0 ? '+' : '') + cagr.toFixed(2) + '%', color: color, size: 'xxl', weight: 'bold' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createAnalysisRow('เดือนแรก', months[0] + ' · ' + _fmtK(firstRev), '#9ca3af'),
            createAnalysisRow('เดือนล่าสุด', months[months.length - 1] + ' · ' + _fmtK(lastRev), '#10b981'),
            createAnalysisRow('จำนวนเดือน', months.length + ' เดือน', '#3b82f6')
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyGrowthRate(replyToken) { replyMoM(replyToken); }

function replyInvTurnover(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthLogs = data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= ms);
    const volume = monthLogs.reduce((s, l) => s + _n(l.qty), 0);
    let cogs = 0;
    monthLogs.forEach(l => { cogs += _n(l.qty) * getUnitCostFromConfig(l.recipeType || 'RED'); });
    const products = data.products || [];
    const stockMap = readStockBalance();
    let totalStock = 0;
    products.forEach(p => {
      const s = stockMap[p.id] !== undefined ? stockMap[p.id] : (stockMap['name:' + p.name] || 0);
      totalStock += Math.max(0, s);
    });
    const avgStock = Math.max(1, (totalStock + volume / 2) / 2);
    const turnover = cogs > 0 ? cogs / avgStock : 0;
    const daysInv = turnover > 0 ? 365 / turnover : 0;
    const color = turnover > 3 ? '#10b981' : turnover > 1 ? '#f59e0b' : '#ef4444';
    const flexMessage = {
      type: 'flex', altText: 'Inventory Turnover',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📦 INVENTORY TURNOVER', weight: 'bold', color: '#3b82f6', size: 'xl' },
          { type: 'text', text: 'อัตราการหมุนเวียนสินค้า', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: 'Turnover Rate', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: turnover.toFixed(2) + 'x', color: color, size: 'xxl', weight: 'bold' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createAnalysisRow('COGS', _fmtK(cogs), '#ef4444'),
            createAnalysisRow('Avg Stock', totalStock + ' ขวด', '#3b82f6'),
            createAnalysisRow('Days Inventory', daysInv.toFixed(0) + ' วัน', '#f59e0b'),
            { type: 'separator', margin: 'md' },
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '💡 ' + (turnover > 3 ? '✅ สินค้าหมุนเวียนดีมาก' : turnover > 1 ? '🟡 หมุนเวียนปานกลาง' : '⚠️ สินค้าค้างstock สูง'), size: 'xs', color: color, wrap: true }
            ], backgroundColor: '#1a1f2e', paddingAll: '10px', cornerRadius: '10px' }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyDSI(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthLogs = data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= ms);
    const products = data.products || [];
    const stockMap = readStockBalance();
    const daysElapsed = Math.max(1, now.getDate());
    let totalCOGS = 0;
    const productRows = products.map(p => {
      const sales = monthLogs.filter(l => l.productName === p.name);
      const vol = sales.reduce((s, l) => s + _n(l.qty), 0);
      const unitCost = getUnitCostFromConfig(p.recipeType);
      const cogs = vol * unitCost;
      totalCOGS += cogs;
      const stock = Math.max(0, stockMap[p.id] !== undefined ? stockMap[p.id] : (stockMap['name:' + p.name] || 0));
      const dailyVol = vol / daysElapsed;
      const dsi = dailyVol > 0 ? Math.floor(stock / dailyVol) : 999;
      return { name: p.name, stock, dailyVol, dsi };
    });
    const totalStock = productRows.reduce((s, p) => s + p.stock, 0);
    const overallDailyCOGS = totalCOGS / daysElapsed;
    const overallDSI = overallDailyCOGS > 0 ? Math.floor(totalStock / overallDailyCOGS * 100) / 100 : 0;
    const dsiColor = overallDSI < 30 ? '#10b981' : overallDSI < 60 ? '#f59e0b' : '#ef4444';
    const productRowsFlex = productRows.filter(p => p.stock > 0).sort((a, b) => b.dsi - a.dsi).slice(0, 8).map(p => {
      const color = p.dsi < 30 ? '#10b981' : p.dsi < 60 ? '#f59e0b' : '#ef4444';
      return createAnalysisRow(p.name.length > 18 ? p.name.substring(0, 18) + '...' : p.name, p.dsi + ' วัน (' + p.stock + ' ขวด)', color);
    });
    const flexMessage = {
      type: 'flex', altText: 'Days Sales of Inventory',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📅 DSI (Days Sales of Inventory)', weight: 'bold', color: '#06b6d4', size: 'lg' },
          { type: 'text', text: 'จำนวนวันที่สต๊อกจะขายหมด', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '🏭 DSI ภาพรวม', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: overallDSI.toFixed(1) + ' วัน', color: dsiColor, size: 'xxl', weight: 'bold' },
              { type: 'text', text: overallDSI < 30 ? '✅ หมุนเวียนเร็ว' : overallDSI < 60 ? '🟡 ปานกลาง' : '⚠️ สต๊อกค้างนาน', color: dsiColor, size: 'sm', margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('สต๊อกรวม', totalStock + ' ขวด', '#3b82f6'),
              createStatBox('COGS เดือน', _fmtK(totalCOGS), '#ef4444')
            ]},
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📦 DSI แต่ละสินค้า (สูงสุด)', '#06b6d4')
          ].concat(productRowsFlex.length > 0 ? productRowsFlex : [{ type: 'text', text: 'ไม่มีข้อมูลการขาย', color: '#6b7280', size: 'sm', align: 'center', margin: 'md' }]),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyDSO(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthLogs = data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= ms);
    const revenue = monthLogs.reduce((s, l) => s + _n(l.total), 0);
    const cashRev = monthLogs.filter(l => l.paymentMethod === 'CASH').reduce((s, l) => s + _n(l.total), 0);
    const dso = revenue > 0 ? ((revenue - cashRev) / revenue) * 30 : 0;
    const flexMessage = {
      type: 'flex', altText: 'DSO',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📅 DSO', weight: 'bold', color: '#f59e0b', size: 'xl' },
          { type: 'text', text: 'Days Sales Outstanding', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: 'DSO', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: dso.toFixed(0) + ' วัน', color: '#f59e0b', size: 'xxl', weight: 'bold' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createAnalysisRow('รายได้รวม', _fmtK(revenue), '#10b981'),
            createAnalysisRow('เงินสดรับ', _fmtK(cashRev), '#10b981'),
            createAnalysisRow('ลูกหนี้ค้าง', _fmtK(revenue - cashRev), '#ef4444'),
            { type: 'text', text: '💡 DSO ต่ำ = เก็บเงินเร็ว = ดี', size: 'xxs', color: '#6b7280', margin: 'md', wrap: true }
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyDPO(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthExps = data.expenses.filter(e => new Date(e.timestamp) >= ms);
    const totalExp = monthExps.reduce((s, e) => s + _n(e.amount), 0);
    const cashExp = monthExps.filter(e => e.paymentMethod === 'CASH').reduce((s, e) => s + _n(e.amount), 0);
    const dpo = totalExp > 0 ? ((totalExp - cashExp) / totalExp) * 30 : 0;
    const flexMessage = {
      type: 'flex', altText: 'DPO',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📅 DPO', weight: 'bold', color: '#06b6d4', size: 'xl' },
          { type: 'text', text: 'Days Payable Outstanding', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: 'DPO', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: dpo.toFixed(0) + ' วัน', color: '#06b6d4', size: 'xxl', weight: 'bold' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createAnalysisRow('รายจ่ายรวม', _fmtK(totalExp), '#ef4444'),
            createAnalysisRow('เงินสดจ่าย', _fmtK(cashExp), '#10b981'),
            createAnalysisRow('เจ้าหนี้ค้าง', _fmtK(totalExp - cashExp), '#f59e0b')
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyCashCycle(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthLogs = data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= ms);
    const monthExps = data.expenses.filter(e => new Date(e.timestamp) >= ms);
    const products = data.products || [];
    const stockMap = readStockBalance();
    const daysElapsed = Math.max(1, now.getDate());
    let totalStock = 0, totalCOGS = 0;
    products.forEach(p => {
      totalStock += Math.max(0, stockMap[p.id] !== undefined ? stockMap[p.id] : (stockMap['name:' + p.name] || 0));
    });
    monthLogs.forEach(l => { totalCOGS += _n(l.qty) * getUnitCostFromConfig(l.recipeType || 'RED'); });
    const dailyCOGS = totalCOGS / daysElapsed;
    const dio = dailyCOGS > 0 ? Math.floor(totalStock / dailyCOGS) : 0;
    const revenue = monthLogs.reduce((s, l) => s + _n(l.total), 0);
    const cashRev = monthLogs.filter(l => l.paymentMethod === 'CASH').reduce((s, l) => s + _n(l.total), 0);
    const dso = revenue > 0 ? ((revenue - cashRev) / revenue) * 30 : 0;
    const totalExp = monthExps.reduce((s, e) => s + _n(e.amount), 0);
    const cashExp = monthExps.filter(e => e.paymentMethod === 'CASH').reduce((s, e) => s + _n(e.amount), 0);
    const dpo = totalExp > 0 ? ((totalExp - cashExp) / totalExp) * 30 : 0;
    const ccc = dio + dso - dpo;
    const cccColor = ccc < 30 ? '#10b981' : ccc < 60 ? '#f59e0b' : '#ef4444';
    const cccLabel = ccc < 0 ? '✨ ยอดเยี่ยม - ได้เงินก่อนจ่าย' : ccc < 30 ? '✅ ดี - วงจรสั้น' : ccc < 60 ? '🟡 ปานกลาง' : '⚠️ วงจรยาว - ควรปรับ';
    const flexMessage = {
      type: 'flex', altText: 'Cash Conversion Cycle',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '🔄 CASH CONVERSION CYCLE', weight: 'bold', color: '#8b5cf6', size: 'lg' },
          { type: 'text', text: 'CCC = DIO + DSO - DPO', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '🎯 Cash Conversion Cycle', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: ccc.toFixed(0) + ' วัน', color: cccColor, size: 'xxl', weight: 'bold' },
              { type: 'text', text: cccLabel, color: cccColor, size: 'sm', margin: 'sm', weight: 'bold' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📊 องค์ประกอบ CCC', '#06b6d4'),
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('DIO', dio + ' วัน', '#3b82f6'),
              createStatBox('DSO', dso.toFixed(0) + ' วัน', '#f59e0b')
            ]},
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('DPO', dpo.toFixed(0) + ' วัน', '#06b6d4'),
              createStatBox('CCC', ccc.toFixed(0) + ' วัน', cccColor)
            ]}
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyStockAlert(replyToken) {
  try {
    const products = getProducts().products || [];
    const stockMap = readStockBalance();
    const alerts = [];
    products.forEach(p => {
      const stock = stockMap[p.id] !== undefined ? stockMap[p.id] : (stockMap['name:' + p.name] || 0);
      if (stock <= 5) alerts.push({ p, stock });
    });
    if (alerts.length === 0) return replyText(replyToken, '✅ สต๊อกทุกรายการเพียงพอ');
    const flexMessage = {
      type: 'flex', altText: 'Stock Alert',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '⚠️ STOCK ALERT', weight: 'bold', color: '#ef4444', size: 'xl' },
          { type: 'text', text: 'สินค้าต้องเติมด่วน', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'sm',
          contents: alerts.map(a => {
            const emoji = a.p.recipeType === 'RED' ? '🔴' : a.p.recipeType === 'BM' ? '🟡' : '⚪';
            const icon = a.stock <= 0 ? '🚫' : '⚠️';
            const color = a.stock <= 0 ? '#ef4444' : '#f59e0b';
            return { type: 'box', layout: 'horizontal', contents: [
              { type: 'text', text: icon + ' ' + emoji + ' ' + a.p.name, size: 'xs', color: '#e5e7eb', flex: 5, wrap: true, weight: 'bold' },
              { type: 'text', text: a.stock + ' ขวด', size: 'sm', color: color, align: 'end', flex: 3, weight: 'bold' }
            ], backgroundColor: '#0f1419', paddingAll: '10px', cornerRadius: '10px', margin: 'sm' };
          }),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyRestock(replyToken) {
  try {
    const data = getAllData();
    const products = data.products || [];
    const now = new Date();
    const t30 = new Date(now.getTime() - 30 * 86400000);
    const rs = data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= t30);
    const stockMap = readStockBalance();
    const recs = products.map(p => {
      const stock = stockMap[p.id] !== undefined ? stockMap[p.id] : (stockMap['name:' + p.name] || 0);
      const sales = rs.filter(l => l.productName === p.name);
      const vol = sales.reduce((s, l) => s + _n(l.qty), 0);
      const dailySales = vol / 30;
      const daysLeft = dailySales > 0 ? Math.floor(stock / dailySales) : 999;
      let recQty = 0;
      if (dailySales > 0 && daysLeft < 14) recQty = Math.ceil(dailySales * 30 - stock);
      return { p, stock, dailySales, daysLeft, recQty };
    }).filter(r => r.recQty > 0);
    if (recs.length === 0) return replyText(replyToken, '✅ ไม่มีสินค้าที่ต้องเติมในตอนนี้');
    const flexMessage = {
      type: 'flex', altText: 'Restock Recommendations',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📦 RESTOCK RECOMMENDATIONS', weight: 'bold', color: '#10b981', size: 'lg' },
          { type: 'text', text: 'แนะนำการเติมสต๊อก 30 วัน', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'sm',
          contents: recs.map(r => {
            const emoji = r.p.recipeType === 'RED' ? '🔴' : r.p.recipeType === 'BM' ? '🟡' : '⚪';
            const color = r.daysLeft <= 3 ? '#ef4444' : r.daysLeft <= 7 ? '#f59e0b' : '#10b981';
            return { type: 'box', layout: 'vertical', contents: [
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: emoji + ' ' + r.p.name, size: 'xs', color: '#e5e7eb', flex: 5, wrap: true, weight: 'bold' },
                { type: 'text', text: 'เหลือ ' + r.daysLeft + ' วัน', size: 'xxs', color: color, align: 'end', flex: 3, weight: 'bold' }
              ]},
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: 'สต๊อก: ' + r.stock + ' ขวด', size: 'xxs', color: '#9ca3af', flex: 3 },
                { type: 'text', text: 'แนะนำเติม: +' + r.recQty + ' ขวด', size: 'xs', color: '#10b981', align: 'end', flex: 4, weight: 'bold' }
              ], margin: 'xs' }
            ], backgroundColor: '#0f1419', paddingAll: '10px', cornerRadius: '10px', margin: 'sm' };
          }),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyVelocity(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const products = data.products || [];
    const now = new Date();
    const t7 = new Date(now.getTime() - 7 * 86400000);
    const t30 = new Date(now.getTime() - 30 * 86400000);
    const velocity = products.map(p => {
      const vol7 = salesLogs.filter(l => l.productName === p.name && new Date(l.timestamp) >= t7).reduce((s, l) => s + _n(l.qty), 0);
      const vol30 = salesLogs.filter(l => l.productName === p.name && new Date(l.timestamp) >= t30).reduce((s, l) => s + _n(l.qty), 0);
      return { name: p.name, recipeType: p.recipeType, v7: vol7 / 7, v30: vol30 / 30 };
    }).filter(v => v.v7 > 0 || v.v30 > 0).sort((a, b) => b.v7 - a.v7);
    const flexMessage = {
      type: 'flex', altText: 'Sales Velocity',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '⚡ SALES VELOCITY', weight: 'bold', color: '#06b6d4', size: 'xl' },
          { type: 'text', text: 'ความเร็วการขาย (ขวด/วัน)', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'sm',
          contents: velocity.length > 0 ? velocity.map(v => {
            const emoji = v.recipeType === 'RED' ? '🔴' : v.recipeType === 'BM' ? '🟡' : '⚪';
            const trending = v.v7 > v.v30 * 1.1 ? '📈' : v.v7 < v.v30 * 0.9 ? '📉' : '➡️';
            return createAnalysisRow(trending + ' ' + emoji + ' ' + (v.name.length > 15 ? v.name.substring(0, 15) + '...' : v.name), v.v7.toFixed(2) + ' / ' + v.v30.toFixed(2) + ' ขวด/วัน', v.v7 > v.v30 ? '#10b981' : '#f59e0b');
          }) : [{ type: 'text', text: 'ไม่มีข้อมูลการขาย', size: 'sm', color: '#6b7280', align: 'center' }],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyHHI(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const t30 = new Date(now.getTime() - 30 * 86400000);
    const salesLogs = data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= t30);
    const prodRev = {};
    salesLogs.forEach(l => { prodRev[l.productName] = (prodRev[l.productName] || 0) + _n(l.total); });
    const totalRev = Object.values(prodRev).reduce((a, b) => a + b, 0);
    const shares = Object.values(prodRev).map(r => (r / totalRev) * 100);
    const hhi = shares.reduce((s, share) => s + Math.pow(share, 2), 0);
    let conc, color;
    if (hhi > 2500) { conc = 'สูงมาก (เสี่ยง!)'; color = '#ef4444'; }
    else if (hhi > 1500) { conc = 'สูงปานกลาง'; color = '#f59e0b'; }
    else { conc = 'ต่ำ (กระจายดี)'; color = '#10b981'; }
    const flexMessage = {
      type: 'flex', altText: 'HHI Index',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📊 HHI INDEX', weight: 'bold', color: '#8b5cf6', size: 'xl' },
          { type: 'text', text: 'Herfindahl-Hirschman Index', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: 'ค่า HHI', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: hhi.toFixed(0), color: color, size: 'xxl', weight: 'bold' },
              { type: 'text', text: conc, color: color, size: 'sm', margin: 'sm', weight: 'bold' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('💡 การแปลผล', '#06b6d4'),
            createAnalysisRow('HHI < 1500', 'กระจายความเสี่ยงดี', '#10b981'),
            createAnalysisRow('1500-2500', 'ปานกลาง', '#f59e0b'),
            createAnalysisRow('HHI > 2500', 'เสี่ยงพึ่งพาสูง', '#ef4444')
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyAnomaly(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    if (salesLogs.length < 5) return replyText(replyToken, '❌ ข้อมูลไม่พอ');
    const totals = salesLogs.map(l => _n(l.total));
    const n = totals.length;
    const mean = totals.reduce((a, b) => a + b, 0) / n;
    const variance = totals.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / n;
    const sd = Math.sqrt(variance);
    const outliers = salesLogs.map(l => {
      const z = sd > 0 ? (_n(l.total) - mean) / sd : 0;
      return { log: l, z };
    }).filter(o => Math.abs(o.z) > 2).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 15);
    const flexMessage = {
      type: 'flex', altText: 'Anomaly Detection',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '⚠️ ANOMALY DETECTION', weight: 'bold', color: '#f59e0b', size: 'xl' },
          { type: 'text', text: 'ตรวจหาค่าผิดปกติ (Z-Score > 2)', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'sm',
          contents: [
            createAnalysisRow('Mean', _fmtK(mean), '#9ca3af'),
            createAnalysisRow('Std Dev', _fmtK(sd), '#9ca3af'),
            createAnalysisRow('Total', n + ' รายการ', '#3b82f6'),
            { type: 'separator', margin: 'md' },
            createSectionTitle('🚨 พบ ' + outliers.length + ' รายการผิดปกติ', '#ef4444')
          ].concat(outliers.length > 0 ? outliers.map(o => {
            const color = o.z > 0 ? '#10b981' : '#ef4444';
            const emoji = o.log.recipeType === 'RED' ? '🔴' : o.log.recipeType === 'BM' ? '🟡' : '⚪';
            return createAnalysisRow(emoji + ' ' + (o.log.productName || 'ไม่ทราบ'), _fmtK(o.log.total) + ' · Z:' + o.z.toFixed(1), color);
          }) : [{ type: 'text', text: '✅ ไม่พบข้อมูลที่ผิดปกติ', size: 'xs', color: '#10b981', align: 'center', margin: 'md' }]),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyHourlyPattern(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const hourly = new Array(24).fill(0);
    salesLogs.forEach(l => { hourly[new Date(l.timestamp).getHours()] += _n(l.qty); });
    const maxVal = Math.max.apply(null, hourly) || 1;
    const flexMessage = {
      type: 'flex', altText: 'Hourly Pattern',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '⏰ HOURLY PATTERN', weight: 'bold', color: '#06b6d4', size: 'xl' },
          { type: 'text', text: 'ยอดขายตามช่วงเวลา', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'sm',
          contents: [
            createSectionTitle('📊 ช่วงเวลาที่ขายดี', '#10b981')
          ].concat([0, 3, 6, 9, 12, 15, 18, 21].map(h => {
            const blocks = [h, h + 1, h + 2];
            const total = blocks.reduce((s, x) => s + hourly[x], 0);
            const pct = (total / (maxVal * 3)) * 100;
            const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
            const color = pct > 70 ? '#10b981' : pct > 40 ? '#f59e0b' : '#6b7280';
            return { type: 'box', layout: 'vertical', contents: [
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: String(h).padStart(2, '0') + ':00-' + String(h + 3).padStart(2, '0') + ':00', size: 'xxs', color: '#9ca3af', flex: 3 },
                { type: 'text', text: total + ' ขวด', size: 'xxs', color: color, align: 'end', flex: 2, weight: 'bold' }
              ]},
              { type: 'text', text: bar, size: 'xxs', color: color, margin: 'xs' }
            ], margin: 'sm' };
          })),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyWeekdayPattern(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const wd = [0, 0, 0, 0, 0, 0, 0];
    const wdTx = [0, 0, 0, 0, 0, 0, 0];
    salesLogs.forEach(l => {
      const d = new Date(l.timestamp);
      const idx = (d.getDay() + 6) % 7;
      wd[idx] += _n(l.total);
      wdTx[idx]++;
    });
    const dayNames = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.'];
    const maxVal = Math.max.apply(null, wd) || 1;
    const bestDay = wd.indexOf(maxVal);
    const flexMessage = {
      type: 'flex', altText: 'Weekday Pattern',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📅 WEEKDAY PATTERN', weight: 'bold', color: '#8b5cf6', size: 'xl' },
          { type: 'text', text: 'วันขายดี · ' + dayNames[bestDay] + ' สูงสุด', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'sm',
          contents: dayNames.map((d, i) => {
            const pct = (wd[i] / maxVal) * 100;
            const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
            const color = i === bestDay ? '#10b981' : pct > 60 ? '#3b82f6' : '#6b7280';
            return { type: 'box', layout: 'vertical', contents: [
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: dayNames[i], size: 'xs', color: '#9ca3af', flex: 2, weight: 'bold' },
                { type: 'text', text: _fmtK(wd[i]), size: 'xs', color: color, align: 'end', flex: 3, weight: 'bold' },
                { type: 'text', text: wdTx[i] + ' บิล', size: 'xxs', color: '#6b7280', align: 'end', flex: 2 }
              ]},
              { type: 'text', text: bar, size: 'xxs', color: color, margin: 'xs' }
            ], margin: 'sm' };
          }),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyTimeSlotPattern(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const slots = { morning: { label: '🌅 เช้า (06-12)', vol: 0, rev: 0, count: 0 }, afternoon: { label: '☀️ กลางวัน (12-17)', vol: 0, rev: 0, count: 0 }, evening: { label: '🌆 เย็น (17-21)', vol: 0, rev: 0, count: 0 }, night: { label: '🌙 กลางคืน (21-06)', vol: 0, rev: 0, count: 0 } };
    salesLogs.forEach(l => {
      const h = new Date(l.timestamp).getHours();
      let slot;
      if (h >= 6 && h < 12) slot = 'morning';
      else if (h >= 12 && h < 17) slot = 'afternoon';
      else if (h >= 17 && h < 21) slot = 'evening';
      else slot = 'night';
      slots[slot].vol += _n(l.qty);
      slots[slot].rev += _n(l.total);
      slots[slot].count++;
    });
    const slotKeys = Object.keys(slots);
    const maxVol = Math.max.apply(null, slotKeys.map(k => slots[k].vol)) || 1;
    const bestSlot = slotKeys.reduce((a, b) => slots[a].vol > slots[b].vol ? a : b);
    const slotRows = slotKeys.map(k => {
      const s = slots[k];
      const pct = maxVol > 0 ? (s.vol / maxVol) * 100 : 0;
      const barLen = Math.round(pct / 5);
      const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
      const color = k === bestSlot ? '#10b981' : s.vol > 0 ? '#3b82f6' : '#6b7280';
      return { type: 'box', layout: 'vertical', contents: [
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: s.label, size: 'xs', color: '#e5e7eb', flex: 4, weight: 'bold' },
          { type: 'text', text: s.vol + ' ขวด', size: 'xs', color: color, align: 'end', flex: 2, weight: 'bold' }
        ]},
        { type: 'text', text: bar, size: 'xs', color: color, margin: 'xs' },
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: 'รายได้ ' + _fmtK(s.rev), size: 'xxs', color: '#9ca3af', flex: 3 },
          { type: 'text', text: s.count + ' บิล', size: 'xxs', color: '#6b7280', align: 'end', flex: 3 }
        ], margin: 'xs' }
      ], backgroundColor: '#0f1419', paddingAll: '10px', cornerRadius: '10px', margin: 'sm' };
    });
    const flexMessage = {
      type: 'flex', altText: 'Time Slot Pattern',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '⏰ TIME SLOT PATTERN', weight: 'bold', color: '#8b5cf6', size: 'xl' },
          { type: 'text', text: 'ยอดขายแบ่งตาม 4 ช่วงเวลา', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'sm',
          contents: slotRows.concat([
            { type: 'separator', margin: 'md' },
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '🏆 ช่วงที่ขายดีที่สุด: ' + slots[bestSlot].label, size: 'xs', color: '#10b981', weight: 'bold' }
            ], backgroundColor: '#1a1f2e', paddingAll: '10px', cornerRadius: '10px' }
          ]),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyTopCustomers(replyToken) {
  try {
    const data = getAllData();
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const customers = {};
    salesLogs.forEach(l => {
      const key = (l.note && l.note.trim()) ? l.note.trim() : 'ลูกค้าทั่วไป';
      if (!customers[key]) customers[key] = { count: 0, total: 0 };
      customers[key].count++;
      customers[key].total += _n(l.total);
    });
    const sorted = Object.keys(customers).map(k => ({ name: k, count: customers[k].count, total: customers[k].total })).sort((a, b) => b.total - a.total).slice(0, 15);
    const flexMessage = {
      type: 'flex', altText: 'Top Customers',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '👥 TOP CUSTOMERS', weight: 'bold', color: '#f59e0b', size: 'xl' },
          { type: 'text', text: 'ลูกค้าชั้นนำ Top 15', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'sm',
          contents: sorted.map((c, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '#' + (i + 1);
            return createAnalysisRow(medal + ' ' + (c.name.length > 18 ? c.name.substring(0, 18) + '...' : c.name), _fmtK(c.total) + ' · ' + c.count + ' บิล', i < 3 ? '#f59e0b' : '#e5e7eb');
          }),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyAdvancedDashboard(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const today = calcStats(data.logs, data.expenses, new Date(now.getFullYear(), now.getMonth(), now.getDate()), now);
    const week = calcStats(data.logs, data.expenses, new Date(now.getTime() - 7 * 86400000), now);
    const month = calcStats(data.logs, data.expenses, new Date(now.getFullYear(), now.getMonth(), 1), now);
    const lastMonth = calcStats(data.logs, data.expenses, new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1));
    const monthGrowth = lastMonth.revenue > 0 ? ((month.revenue - lastMonth.revenue) / lastMonth.revenue) * 100 : 0;
    let cogs = 0;
    data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= new Date(now.getFullYear(), now.getMonth(), 1)).forEach(l => {
      cogs += _n(l.qty) * getUnitCostFromConfig(l.recipeType || 'RED');
    });
    const gm = month.revenue > 0 ? ((month.revenue - cogs) / month.revenue) * 100 : 0;
    const nm = month.revenue > 0 ? (month.profit / month.revenue) * 100 : 0;
    const products = data.products || [];
    const stockMap = readStockBalance();
    let totalStock = 0, lowStock = 0;
    products.forEach(p => { const s = stockMap[p.id] || 0; totalStock += s; if (s <= 5) lowStock++; });
    const healthScore = Math.round((nm > 20 ? 30 : nm > 0 ? 15 : 0) + (gm > 50 ? 20 : gm > 30 ? 10 : 0) + (monthGrowth > 10 ? 20 : monthGrowth > 0 ? 10 : 0) + (lowStock === 0 ? 15 : 0) + (totalStock > 50 ? 15 : 5));
    const flexMessage = {
      type: 'flex', altText: 'Advanced Dashboard',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '🚀 ADVANCED DASHBOARD', weight: 'bold', color: '#10b981', size: 'xl' },
          { type: 'text', text: formatThaiDate(now), color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '💯 Business Health', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: String(healthScore) + '/100', color: healthScore >= 80 ? '#10b981' : healthScore >= 60 ? '#3b82f6' : healthScore >= 40 ? '#f59e0b' : '#ef4444', size: 'xxl', weight: 'bold' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('วันนี้', _fmtK(today.revenue), '#10b981'),
              createStatBox('7 วัน', _fmtK(week.revenue), '#3b82f6')
            ]},
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('เดือนนี้', _fmtK(month.revenue), '#f59e0b'),
              createStatBox('กำไร', _fmtK(month.profit), month.profit >= 0 ? '#10b981' : '#ef4444')
            ]},
            { type: 'separator', margin: 'md' },
            createSectionTitle('📊 KPIs', '#8b5cf6'),
            createAnalysisRow('MoM Growth', (monthGrowth >= 0 ? '+' : '') + monthGrowth.toFixed(1) + '%', monthGrowth >= 0 ? '#10b981' : '#ef4444'),
            createAnalysisRow('Gross Margin', gm.toFixed(1) + '%', gm > 50 ? '#10b981' : '#f59e0b'),
            createAnalysisRow('Net Margin', nm.toFixed(1) + '%', nm > 20 ? '#10b981' : nm > 0 ? '#f59e0b' : '#ef4444'),
            createAnalysisRow('สต๊อกรวม', totalStock + ' ขวด', '#3b82f6'),
            createAnalysisRow('สินค้าใกล้หมด', lowStock + ' รายการ', lowStock > 0 ? '#ef4444' : '#10b981')
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyScorecard(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const month = calcStats(data.logs, data.expenses, new Date(now.getFullYear(), now.getMonth(), 1), now);
    const lastMonth = calcStats(data.logs, data.expenses, new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1));
    const growth = lastMonth.revenue > 0 ? ((month.revenue - lastMonth.revenue) / lastMonth.revenue) * 100 : 0;
    const nm = month.revenue > 0 ? (month.profit / month.revenue) * 100 : 0;
    const velocity = month.volume / Math.max(1, now.getDate());
    const metrics = [
      { label: 'Revenue Growth', value: growth, target: 10, fmt: v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%' },
      { label: 'Net Margin', value: nm, target: 20, fmt: v => v.toFixed(1) + '%' },
      { label: 'Velocity', value: velocity, target: 20, fmt: v => v.toFixed(1) }
    ];
    const flexMessage = {
      type: 'flex', altText: 'Business Scorecard',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '🏆 BUSINESS SCORECARD', weight: 'bold', color: '#8b5cf6', size: 'xl' },
          { type: 'text', text: 'คะแนน BI · เดือนนี้', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: metrics.map(m => {
            const pct = Math.min(100, (Math.max(0, m.value) / m.target) * 100);
            const color = pct >= 100 ? '#10b981' : pct >= 75 ? '#3b82f6' : pct >= 50 ? '#f59e0b' : '#ef4444';
            const barLen = Math.round(pct / 5);
            const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
            return { type: 'box', layout: 'vertical', contents: [
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: m.label, size: 'xs', color: '#e5e7eb', weight: 'bold', flex: 4 },
                { type: 'text', text: m.fmt(m.value), size: 'sm', color: color, align: 'end', flex: 3, weight: 'bold' }
              ]},
              { type: 'text', text: bar, size: 'xs', color: color, margin: 'xs' },
              { type: 'text', text: 'Target: ' + m.fmt(m.target) + ' · Progress: ' + pct.toFixed(0) + '%', size: 'xxs', color: '#6b7280', margin: 'xs' }
            ], backgroundColor: '#0f1419', paddingAll: '10px', cornerRadius: '10px', margin: 'sm' };
          }),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyBusinessHealth(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const month = calcStats(data.logs, data.expenses, ms, now);
    const lastMonth = calcStats(data.logs, data.expenses, new Date(now.getFullYear(), now.getMonth() - 1, 1), ms);
    let cogs = 0;
    data.logs.filter(l => l.type === 'OUT' && new Date(l.timestamp) >= ms).forEach(l => {
      cogs += _n(l.qty) * getUnitCostFromConfig(l.recipeType || 'RED');
    });
    const revenue = month.revenue;
    const expenses = month.expenses;
    const grossProfit = revenue - cogs;
    const netProfit = month.profit;
    const gm = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
    const nm = revenue > 0 ? (netProfit / revenue) * 100 : 0;
    const growth = lastMonth.revenue > 0 ? ((revenue - lastMonth.revenue) / lastMonth.revenue) * 100 : 0;
    const profitabilityScore = nm > 25 ? 25 : nm > 15 ? 20 : nm > 5 ? 15 : nm > 0 ? 10 : 0;
    const efficiencyScore = gm > 60 ? 25 : gm > 45 ? 20 : gm > 30 ? 15 : gm > 15 ? 8 : 0;
    const growthScore = growth > 20 ? 25 : growth > 10 ? 20 : growth > 0 ? 15 : growth > -10 ? 8 : 0;
    const stabilityScore = Math.min(25, Math.max(0, Math.round((Math.abs(expenses - (lastMonth.expenses || expenses)) / Math.max(1, revenue)) * 100)));
    const totalScore = profitabilityScore + efficiencyScore + growthScore + (25 - stabilityScore);
    const grade = totalScore >= 85 ? 'A - ดีเยี่ยม' : totalScore >= 70 ? 'B - ดี' : totalScore >= 55 ? 'C - ปานกลาง' : totalScore >= 40 ? 'D - ต้องปรับปรุง' : 'F - วิกฤติ';
    const gradeColor = totalScore >= 85 ? '#10b981' : totalScore >= 70 ? '#3b82f6' : totalScore >= 55 ? '#f59e0b' : '#ef4444';
    const dimensionRow = (icon, label, score, max, color) => ({
      type: 'box', layout: 'vertical', contents: [
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: icon + ' ' + label, size: 'xs', color: '#e5e7eb', flex: 4, weight: 'bold' },
          { type: 'text', text: score + '/' + max, size: 'xs', color: color, align: 'end', flex: 2, weight: 'bold' }
        ]},
        { type: 'text', text: '█'.repeat(Math.round(score / max * 20)) + '░'.repeat(20 - Math.round(score / max * 20)), size: 'xs', color: color, margin: 'xs' }
      ], backgroundColor: '#0f1419', paddingAll: '10px', cornerRadius: '10px', margin: 'sm'
    });
    const flexMessage = {
      type: 'flex', altText: 'Business Health Check',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '🏥 BUSINESS HEALTH CHECK', weight: 'bold', color: gradeColor, size: 'xl' },
          { type: 'text', text: 'สุขภาพธุรกิจ 4 มิติ · เดือนนี้', color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '💯 Overall Health Score', color: '#9ca3af', size: 'xs', align: 'center' },
              { type: 'text', text: totalScore + '/100', color: gradeColor, size: 'xxl', weight: 'bold', align: 'center', margin: 'xs' },
              { type: 'text', text: grade, color: gradeColor, size: 'sm', align: 'center', weight: 'bold', margin: 'xs' }
            ], backgroundColor: '#0f1419', paddingAll: '14px', cornerRadius: '12px' },
            { type: 'separator', margin: 'lg' },
            createSectionTitle('📊 4 Health Dimensions', '#8b5cf6'),
            dimensionRow('💰', 'Profitability', profitabilityScore, 25, profitabilityScore >= 20 ? '#10b981' : profitabilityScore >= 10 ? '#f59e0b' : '#ef4444'),
            dimensionRow('⚡', 'Efficiency', efficiencyScore, 25, efficiencyScore >= 20 ? '#10b981' : efficiencyScore >= 10 ? '#f59e0b' : '#ef4444'),
            dimensionRow('📈', 'Growth', growthScore, 25, growthScore >= 20 ? '#10b981' : growthScore >= 10 ? '#f59e0b' : '#ef4444'),
            dimensionRow('🎯', 'Stability', 25 - stabilityScore, 25, stabilityScore < 10 ? '#10b981' : stabilityScore < 20 ? '#f59e0b' : '#ef4444')
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyFullReport(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const month = calcStats(data.logs, data.expenses, new Date(now.getFullYear(), now.getMonth(), 1), now);
    const lastMonth = calcStats(data.logs, data.expenses, new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1));
    const growth = lastMonth.revenue > 0 ? ((month.revenue - lastMonth.revenue) / lastMonth.revenue) * 100 : 0;
    const nm = month.revenue > 0 ? (month.profit / month.revenue) * 100 : 0;
    const products = data.products || [];
    const stockMap = readStockBalance();
    let totalStock = 0, lowStock = 0;
    products.forEach(p => {
      const s = stockMap[p.id] !== undefined ? stockMap[p.id] : (stockMap['name:' + p.name] || 0);
      totalStock += s;
      if (s <= 5) lowStock++;
    });
    const salesLogs = data.logs.filter(l => l.type === 'OUT');
    const customerSet = new Set();
    salesLogs.forEach(l => { if (l.note && l.note.trim()) customerSet.add(l.note.trim()); });
    const flexMessage = {
      type: 'flex', altText: 'Full Business Report',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '📊 FULL BUSINESS REPORT', weight: 'bold', color: '#10b981', size: 'xl' },
          { type: 'text', text: formatThaiDate(now), color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            createSectionTitle('💰 Financial', '#10b981'),
            createAnalysisRow('รายได้เดือนนี้', _fmtK(month.revenue), '#10b981'),
            createAnalysisRow('กำไรสุทธิ', _fmtK(month.profit), month.profit >= 0 ? '#10b981' : '#ef4444'),
            createAnalysisRow('Net Margin', nm.toFixed(1) + '%', nm > 20 ? '#10b981' : '#f59e0b'),
            createAnalysisRow('MoM Growth', (growth >= 0 ? '+' : '') + growth.toFixed(1) + '%', growth >= 0 ? '#10b981' : '#ef4444'),
            { type: 'separator', margin: 'md' },
            createSectionTitle('📦 Operations', '#3b82f6'),
            createAnalysisRow('สินค้าทั้งหมด', products.length + ' รายการ', '#3b82f6'),
            createAnalysisRow('สต๊อกรวม', totalStock + ' ขวด', totalStock > 50 ? '#10b981' : '#f59e0b'),
            createAnalysisRow('สต๊อกต่ำ', lowStock + ' รายการ', lowStock > 0 ? '#ef4444' : '#10b981'),
            createAnalysisRow('จำนวนบิล (ทั้งหมด)', salesLogs.length + ' บิล', '#8b5cf6'),
            createAnalysisRow('ลูกค้า (ตามชื่อ)', customerSet.size + ' ราย', '#f59e0b'),
            { type: 'separator', margin: 'md' },
            createSectionTitle('📊 Performance', '#f59e0b'),
            createAnalysisRow('ปริมาณเดือนนี้', month.volume + ' ขวด', '#3b82f6'),
            createAnalysisRow('บิลเดือนนี้', month.txCount + ' บิล', '#8b5cf6'),
            createAnalysisRow('เฉลี่ย/บิล', _fmtK(month.txCount > 0 ? month.revenue / month.txCount : 0), '#10b981')
          ],
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyExecutiveSummary(replyToken) {
  try {
    const data = getAllData();
    const now = new Date();
    const month = calcStats(data.logs, data.expenses, new Date(now.getFullYear(), now.getMonth(), 1), now);
    const lastMonth = calcStats(data.logs, data.expenses, new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1));
    const growth = lastMonth.revenue > 0 ? ((month.revenue - lastMonth.revenue) / lastMonth.revenue) * 100 : 0;
    const nm = month.revenue > 0 ? (month.profit / month.revenue) * 100 : 0;
    const velocity = month.volume / Math.max(1, now.getDate());
    const insights = [];
    if (growth > 10) insights.push('📈 ยอดขายเติบโต ' + growth.toFixed(1) + '%');
    else if (growth < -10) insights.push('📉 ยอดขายลดลง ' + Math.abs(growth).toFixed(1) + '%');
    if (nm > 30) insights.push('💎 กำไรดีมาก ' + nm.toFixed(1) + '%');
    else if (nm < 0) insights.push('🔴 ขาดทุน! ต้องแก้ไข');
    if (velocity > 20) insights.push('🚀 ขายเร็ว ' + velocity.toFixed(1) + ' ขวด/วัน');
    else if (velocity < 5) insights.push('🐌 ขายช้า ' + velocity.toFixed(1) + ' ขวด/วัน');
    const flexMessage = {
      type: 'flex', altText: 'Executive Summary',
      contents: { type: 'bubble', size: 'giga',
        header: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '👔 EXECUTIVE SUMMARY', weight: 'bold', color: '#10b981', size: 'xl' },
          { type: 'text', text: formatThaiDate(now), color: '#9ca3af', size: 'xs', margin: 'sm' }
        ], backgroundColor: '#0a0c10', paddingAll: '16px' },
        body: { type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '💰 รายได้เดือนนี้', color: '#9ca3af', size: 'xs' },
              { type: 'text', text: _fmtK(month.revenue), color: '#10b981', size: 'xxl', weight: 'bold' },
              { type: 'text', text: (growth >= 0 ? '📈 +' : '📉 ') + growth.toFixed(1) + '% จากเดือนก่อน', color: growth >= 0 ? '#10b981' : '#ef4444', size: 'sm', margin: 'sm' }
            ], backgroundColor: '#0f1419', paddingAll: '12px', cornerRadius: '12px' },
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('กำไร', _fmtK(month.profit), month.profit >= 0 ? '#10b981' : '#ef4444'),
              createStatBox('Margin', nm.toFixed(1) + '%', nm > 20 ? '#10b981' : '#f59e0b')
            ]},
            { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
              createStatBox('ปริมาณ', month.volume + ' ขวด', '#3b82f6'),
              createStatBox('Velocity', velocity.toFixed(1) + '/วัน', '#f59e0b')
            ]},
            { type: 'separator', margin: 'md' },
            createSectionTitle('💡 Strategic Insights', '#8b5cf6')
          ].concat(insights.length > 0 ? insights.map(i => ({ type: 'text', text: i, size: 'sm', color: '#e5e7eb', margin: 'sm', wrap: true })) : [{ type: 'text', text: 'ไม่มีข้อมูลเพียงพอ', size: 'sm', color: '#6b7280', margin: 'sm' }]),
          paddingAll: '16px'
        },
        styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
      }
    };
    replyFlex(replyToken, flexMessage);
  } catch (err) { replyText(replyToken, '❌ ' + err.toString()); }
}

function replyHelp(replyToken, isAdmin) {
  const flexMessage = {
    type: 'flex',
    altText: 'เมนูคำสั่ง Kratom POS v' + CONFIG.VERSION,
    contents: {
      type: 'bubble', size: 'giga',
      header: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'text', text: '🍃 KRATOM POS v' + CONFIG.VERSION, weight: 'bold', color: '#10b981', size: 'xl' },
          { type: 'text', text: '41 Advanced KPIs · StockBalance · Quota-Optimized', color: '#9ca3af', size: 'sm', margin: 'sm' }
        ],
        backgroundColor: '#0a0c10', paddingAll: '20px'
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          createHelpSection('⭐ แนะนำ (ประหยัดโควต้า)', '#f59e0b', [
            ['สรุป', 'ทุกอย่างใน 1 ข้อความ'],
            ['วันนี้ ฝาแดง14 BM16 T4', 'บันทึกการขาย']
          ]),
          createHelpSection('🛒 บันทึกการขาย', '#10b981', [
            ['วันนี้ ฝาแดง14 BM16 T4', 'บันทึกวันนี้'],
            ['พรุ่งนี้ A14 BM16 T4', 'บันทึกพรุ่งนี้'],
            ['15/10/26 A14 BM16 T4', 'ระบุวันที่']
          ]),
          createHelpSection('📊 รายงานหลัก', '#f59e0b', [
            ['รายงานวันนี้', 'รายงานรายวัน'],
            ['รายงานสัปดาห์', 'รายงาน 7 วัน'],
            ['รายงานเดือน', 'รายงานรายเดือน']
          ]),
          createHelpSection('🎯 Advanced Analytics', '#06b6d4', [
            ['rfm', 'Customer RFM'],
            ['abc', 'ABC Analysis'],
            ['cohort', 'Cohort'],
            ['basket', 'Basket'],
            ['seasonal', 'Seasonal']
          ]),
          createHelpSection('💰 Financial', '#3b82f6', [
            ['pnl', 'P&L Statement'],
            ['ratios', 'Financial Ratios'],
            ['breakeven', 'Break-Even'],
            ['cashflow', 'Cash Flow'],
            ['runway', 'Cash Runway']
          ]),
          createHelpSection('📦 Product', '#10b981', [
            ['สินค้า', 'วิเคราะห์สินค้า'],
            ['ท็อป', 'Top Products'],
            ['สต๊อก', 'Stock Report'],
            ['stockalert', 'Stock Alert'],
            ['restock', 'แนะนำเติม']
          ]),
          createHelpSection('📈 Growth', '#ec4899', [
            ['mom', 'MoM Growth'],
            ['qoq', 'QoQ Growth'],
            ['yoy', 'YoY Growth'],
            ['cagr', 'CAGR']
          ]),
          createHelpSection('👥 Customer', '#a78bfa', [
            ['clv', 'Customer Lifetime Value'],
            ['churn', 'Churn Rate'],
            ['segment', 'Segmentation'],
            ['topcustomer', 'Top Customers']
          ]),
          createHelpSection('🎯 KPI & Scorecard', '#8b5cf6', [
            ['kpi', 'KPI Dashboard'],
            ['เป้าหมาย', 'ตั้งเป้า'],
            ['scorecard', 'Business Scorecard'],
            ['health', 'Business Health'],
            ['executive', 'Executive Summary']
          ])
        ],
        paddingAll: '16px'
      },
      styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
    }
  };
  replyFlex(replyToken, flexMessage);
}

function replyUnknownCommand(replyToken, text) {
  const flexMessage = {
    type: 'flex',
    altText: 'ไม่รู้จักคำสั่ง',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical',
        contents: [{ type: 'text', text: '❓ ไม่รู้จักคำสั่ง', weight: 'bold', color: '#f59e0b', size: 'md' }],
        backgroundColor: '#0a0c10', paddingAll: '16px'
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: 'ข้อความ: "' + text + '"', size: 'xs', color: '#9ca3af', wrap: true },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: 'ลองพิมพ์คำสั่งเหล่านี้:', size: 'sm', color: '#ffffff', weight: 'bold', margin: 'md' },
          { type: 'text', text: '• สรุป · วันนี้ · แดชบอร์ด', size: 'xs', color: '#10b981', wrap: true, margin: 'sm' },
          { type: 'text', text: '• rfm · clv · churn · pnl', size: 'xs', color: '#3b82f6', wrap: true, margin: 'sm' },
          { type: 'text', text: '• abc · pareto · breakeven', size: 'xs', color: '#8b5cf6', wrap: true, margin: 'sm' },
          { type: 'text', text: '• ช่วยเหลือ (เมนูทั้งหมด)', size: 'xs', color: '#ec4899', wrap: true, margin: 'sm' }
        ],
        paddingAll: '16px'
      },
      styles: { header: { backgroundColor: '#0a0c10' }, body: { backgroundColor: '#0a0c10' } }
    }
  };
  replyFlex(replyToken, flexMessage);
}

// ============================================================================
// 📌 AUTO SEND REPORTS — Quota-Optimized
// ============================================================================
function sendDailyReport() {
  try {
    if (!LINE_CONFIG.ADMIN_USER_ID || LINE_CONFIG.ADMIN_USER_ID.indexOf('PUT_YOUR') === 0) {
      console.warn('[DailyReport] Admin user ID not configured');
      return;
    }
    const now = new Date();
    const isSunday = now.getDay() === 0;
    let flex;
    let label = 'Daily';
    if (isSunday && CONFIG.QUOTA.WEEKLY_REPORT_ENABLED) {
      flex = buildWeeklyReportFlex(now);
      label = 'Weekly';
    } else {
      flex = buildDailyReportFlex(now);
    }
    const r = pushMessage(LINE_CONFIG.ADMIN_USER_ID, [flex]);
    console.log('[' + label + 'Report] Sent:', r && r.getResponseCode());
    if (CONFIG.QUOTA.STOCK_ALERT_ENABLED) {
      try {
        const products = getAllData().products || [];
        const stockMap = readStockBalance();
        const lowStock = products.filter(p => {
          const s = stockMap[p.id] !== undefined ? stockMap[p.id] : (stockMap['name:' + p.name] || 0);
          return s <= 5;
        });
        if (lowStock.length > 0) {
          console.log('[StockAlert] ' + lowStock.length + ' items low');
        }
      } catch (e) { console.warn('[DailyReport] Stock alert error:', e); }
    }
  } catch (err) { console.error('sendDailyReport error:', err); }
}

function sendWeeklyReport() {
  try {
    if (!LINE_CONFIG.ADMIN_USER_ID || LINE_CONFIG.ADMIN_USER_ID.indexOf('PUT_YOUR') === 0) return;
    const flex = buildWeeklyReportFlex(new Date());
    const r = pushMessage(LINE_CONFIG.ADMIN_USER_ID, [flex]);
    console.log('[WeeklyReport] Sent:', r && r.getResponseCode());
  } catch (err) { console.error('sendWeeklyReport error:', err); }
}

function sendMonthlyReport() {
  try {
    if (!LINE_CONFIG.ADMIN_USER_ID || LINE_CONFIG.ADMIN_USER_ID.indexOf('PUT_YOUR') === 0) return;
    const now = new Date();
    const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    const flex = buildMonthlyReportFlex(prevMonthDate);
    const r = pushMessage(LINE_CONFIG.ADMIN_USER_ID, [flex]);
    console.log('[MonthlyReport] Sent:', r && r.getResponseCode());
  } catch (err) { console.error('sendMonthlyReport error:', err); }
}

// ============================================================================
// 📌 TRIGGERS
// ============================================================================
function dailyStatsTrigger() {
  try {
    const today = new Date();
    updateDailyStats(today.toISOString());
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const auditSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.AUDIT);
    if (auditSheet && auditSheet.getLastRow() > 10000) auditSheet.deleteRows(2, auditSheet.getLastRow() - 5000);
    console.log('Daily trigger completed at ' + today.toISOString());
  } catch (err) { console.error('dailyStatsTrigger error:', err); }
}

function autoBackupTrigger() {
  try {
    const result = createBackup();
    console.log('Auto backup: ' + JSON.stringify(result));
  } catch (err) { console.error('autoBackupTrigger error:', err); }
}

function installTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) {
    const fn = t.getHandlerFunction();
    if (['dailyStatsTrigger', 'autoBackupTrigger', 'sendDailyReport', 'sendWeeklyReport', 'sendMonthlyReport'].includes(fn)) {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('dailyStatsTrigger').timeBased().everyDays(1).atHour(1).create();
  ScriptApp.newTrigger('autoBackupTrigger').timeBased().everyHours(6).create();
  if (CONFIG.QUOTA.DAILY_REPORT_ENABLED) {
    ScriptApp.newTrigger('sendDailyReport').timeBased().atHour(LINE_CONFIG.DAILY_REPORT_HOUR || 21).everyDays(1).create();
  }
  if (CONFIG.QUOTA.WEEKLY_REPORT_ENABLED) {
    ScriptApp.newTrigger('sendWeeklyReport').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(21).create();
  }
  if (CONFIG.QUOTA.MONTHLY_REPORT_ENABLED) {
    ScriptApp.newTrigger('sendMonthlyReport').timeBased().onMonthDay(1).atHour(9).create();
  }
  return {
    status: 'success',
    message: 'Triggers installed (quota-optimized)',
    triggers: ScriptApp.getProjectTriggers().length,
    lineMessagesPerMonth: (CONFIG.QUOTA.DAILY_REPORT_ENABLED ? 30 : 0) +
                          (CONFIG.QUOTA.WEEKLY_REPORT_ENABLED ? 4 : 0) +
                          (CONFIG.QUOTA.MONTHLY_REPORT_ENABLED ? 1 : 0)
  };
}

// ============================================================================
// 📌 FULL SYSTEM INSTALLATION
// ============================================================================
function installSystem() {
  console.log('🚀 Starting full system installation v' + CONFIG.VERSION + '...');
  const summary = { timestamp: new Date().toISOString(), version: CONFIG.VERSION };
  console.log('Step 1: Setting up spreadsheet...');
  try {
    summary.setup = setupSpreadsheet();
    console.log('✅ Spreadsheet setup complete');
  } catch (e) {
    summary.setup = { status: 'error', message: e.toString() };
    console.error('❌ Spreadsheet setup failed:', e);
  }
  console.log('Step 2: Setting up StockBalance...');
  try {
    seedStockBalance(SpreadsheetApp.getActiveSpreadsheet());
    summary.stockBalance = { status: 'success' };
    console.log('✅ StockBalance ready');
  } catch (e) {
    summary.stockBalance = { status: 'error', message: e.toString() };
    console.error('❌ StockBalance failed:', e);
  }
  console.log('Step 3: Setting up secrets (if not set)...');
  try {
    const props = PropertiesService.getScriptProperties();
    if (!props.getProperty('LINE_CHANNEL_ACCESS_TOKEN') && LINE_CONFIG.CHANNEL_ACCESS_TOKEN) {
      props.setProperty('LINE_CHANNEL_ACCESS_TOKEN', LINE_CONFIG.CHANNEL_ACCESS_TOKEN);
    }
    if (!props.getProperty('LINE_CHANNEL_SECRET') && LINE_CONFIG.CHANNEL_SECRET) {
      props.setProperty('LINE_CHANNEL_SECRET', LINE_CONFIG.CHANNEL_SECRET);
    }
    if (!props.getProperty('LINE_ADMIN_USER_ID') && LINE_CONFIG.ADMIN_USER_ID) {
      props.setProperty('LINE_ADMIN_USER_ID', LINE_CONFIG.ADMIN_USER_ID);
    }
    summary.secrets = 'set';
    console.log('✅ Secrets set');
  } catch (e) {
    summary.secrets = 'error: ' + e.toString();
  }
  console.log('Step 4: Installing triggers...');
  try {
    summary.triggers = installTriggers();
    console.log('✅ Triggers installed');
  } catch (e) {
    summary.triggers = { status: 'error', message: e.toString() };
    console.error('❌ Triggers failed:', e);
  }
  console.log('Step 5: Running health check...');
  try {
    summary.health = healthCheck();
    console.log('✅ Health check passed');
  } catch (e) {
    summary.health = { status: 'error', message: e.toString() };
    console.error('❌ Health check failed:', e);
  }
  console.log('Step 6: Testing LINE connection...');
  try {
    if (LINE_CONFIG.CHANNEL_ACCESS_TOKEN && LINE_CONFIG.CHANNEL_ACCESS_TOKEN.indexOf('PUT_YOUR') !== 0) {
      const testMsg = pushMessage(LINE_CONFIG.ADMIN_USER_ID, [{
        type: 'text',
        text: '🍃 KRATOM POS v' + CONFIG.VERSION + ' ติดตั้งสำเร็จ!\n\n' +
              '📊 Version: ' + CONFIG.VERSION + '\n' +
              '✨ 41 Advanced KPIs + StockBalance\n' +
              '🎯 Reply-only (ประหยัดโควต้า!)\n' +
              '🛒 บันทึกขาย: วันนี้ ฝาแดง14 BM16 T4\n' +
              '⭐ พิมพ์ "สรุป" = ทุกอย่างใน 1 ข้อความ\n\n' +
              'พิมพ์ "ช่วยเหลือ" เพื่อดูทั้งหมด'
      }]);
      summary.lineTest = testMsg && testMsg.getResponseCode() === 200 ? 'success' : 'failed';
      console.log('✅ LINE test:', summary.lineTest);
    } else {
      summary.lineTest = 'skipped';
    }
  } catch (e) {
    summary.lineTest = 'error: ' + e.toString();
  }
  summary.status = 'success';
  summary.nextSteps = [
    '1. Deploy > New deployment > Web app',
    '2. Execute as: Me, Access: Anyone',
    '3. Copy Web App URL',
    '4. Paste URL into LINE Developers Webhook',
    '5. Verify webhook',
    '6. Paste URL into POS settings'
  ];
  console.log('========================================');
  console.log('🎉 INSTALLATION COMPLETE');
  console.log('========================================');
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function setupLineBot() {
  const results = { webhook: 'Not tested', token: 'Set', secret: 'Set', triggers: 'Not installed' };
  try {
    if (LINE_CONFIG.CHANNEL_ACCESS_TOKEN.indexOf('PUT_YOUR') === 0) {
      results.webhook = 'LINE token not configured';
      return results;
    }
    const url = LINE_CONFIG.API_ENDPOINT + '/info';
    const response = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': 'Bearer ' + LINE_CONFIG.CHANNEL_ACCESS_TOKEN },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() === 200) results.webhook = 'Connected';
  } catch (e) { results.webhook = 'Error: ' + e.toString(); }
  try { installTriggers(); results.triggers = 'Installed'; }
  catch (e) { results.triggers = 'Error: ' + e.toString(); }
  try {
    pushMessage(LINE_CONFIG.ADMIN_USER_ID, [{ type: 'text', text: '🍃 Kratom POS Bot v' + CONFIG.VERSION + ' พร้อมใช้งาน!\n\nVersion: ' + CONFIG.VERSION + '\nWebhook: ' + results.webhook + '\n\nพิมพ์ "สรุป" หรือ "ช่วยเหลือ"' }]);
    results.test = 'Message sent';
  } catch (e) { results.test = 'Error: ' + e.toString(); }
  return results;
}

function testLineBot() {
  const results = {};
  try {
    const pushResult = pushMessage(LINE_CONFIG.ADMIN_USER_ID, [{ type: 'text', text: '🧪 TEST v' + CONFIG.VERSION + '\n\n' + new Date().toLocaleString('th-TH') + '\n\n✅ ระบบทำงานปกติ\n41 Advanced KPIs + StockBalance' }]);
    results.sendMessage = pushResult && pushResult.getResponseCode() === 200 ? '✅ OK' : '❌ ' + (pushResult ? pushResult.getResponseCode() : 'no response');
  } catch (e) { results.sendMessage = '❌ ' + e.toString(); }
  try {
    const profile = getLineProfile(LINE_CONFIG.ADMIN_USER_ID);
    results.getProfile = profile.displayName ? '✅ ' + profile.displayName : '❌ No profile';
  } catch (e) { results.getProfile = '❌ ' + e.toString(); }
  try {
    const data = getAllData();
    results.dataAccess = '✅ logs: ' + data.logs.length + ', expenses: ' + data.expenses.length + ', products: ' + data.products.length;
  } catch (e) { results.dataAccess = '❌ ' + e.toString(); }
  return results;
}

function checkFunctions() {
  const required = [
    'doGet', 'doPost', 'handleRequest', 'jsonResponse',
    'getAllData', 'getLogs', 'getExpenses', 'getProducts', 'getConfig', 'getStats',
    'getStock', 'getStockHistory', 'rebuildStockBalance',
    'addLog', 'addExpense', 'saveProduct', 'saveConfig', 'saveBatch',
    'deleteLog', 'deleteExpense', 'deleteProduct',
    'readSheetAsObjects', 'readConfigAsObject', 'getHeaders',
    'withLock', 'invalidateCache', 'logAudit', 'getClientIp',
    'setupSpreadsheet', 'ensureSheet', 'seedDefaultData', 'seedStockBalance', 'formatSheets',
    'healthCheck', 'createBackup', 'updateDailyStats',
    '_getSecret', 'setSecret',
    'readStockBalance', 'updateStockBalance', 'logStockHistory',
    'shouldReply', 'canPush', 'getPushStats', 'suggestAggregate',
    'handleLineWebhook', 'verifyLineSignature', 'handleTextMessage',
    'handleImageMessage', 'handleLocationMessage', 'handlePostback',
    'handleFollow', 'handleJoin',
    'parseCommand', 'parseSaleCommand', 'replyText', 'replyFlex', 'pushMessage', 'getLineProfile',
    'handleSaleCommand', 'recordSaleFromLine', 'findProductForSale',
    'replySaleConfirmation', 'replySaleError',
    'replySummaryAllInOne',
    'buildDailyReportFlex', 'buildWeeklyReportFlex', 'buildMonthlyReportFlex',
    'replyDailyReport', 'replyWeeklyReport', 'replyMonthlyReport',
    'sendDailyReport', 'sendWeeklyReport', 'sendMonthlyReport',
    'replyDashboard', 'replySalesReport', 'replyProfitReport', 'replyCostAnalysis',
    'replyStockReport', 'replyTopProducts', 'replyProductAnalysis', 'replyProductDetail',
    'replyMarketShare', 'replyKPIDashboard', 'replyKPITarget', 'replySetTarget',
    'replyTrendAnalysis', 'replyComparison', 'replyForecast', 'replyFullAnalysis',
    'replyCashFlow', 'replyCashFlowForecast', 'replyCustomerStats',
    'replyHelp', 'replyUnknownCommand',
    'calcStats', 'getFilteredDataByPeriod', 'calculateStockForProduct',
    'getUnitCostFromConfig', 'getAverageUnitCost',
    'createStatBox', 'createAnalysisRow', 'createSectionTitle',
    'createQuickButton', 'createHelpSection',
    'generateQuickAdvice', 'generateCashAdvice',
    'formatThaiDate', 'formatThaiDateShort', 'looksLikeSaleAttempt',
    '_n', '_pct', '_fmtK', '_growthReply',
    'replySalesKPIDashboard', 'replyBusinessKPIDashboard', 'replyDeepAnalysis',
    'replyRFMAnalysis', 'replyABCAnalysis', 'replySeasonalAnalysis',
    'replyBasketAnalysis', 'replyCohortAnalysis',
    '_buildCustomerSegmentsBlock', '_buildDeepRecommendations',
    'replyCLV', 'replyChurn', 'replySegment', 'replyAOVTrend', 'replyPnL',
    'replyFinancialRatios', 'replyBreakEven', 'replySensitivity', 'replyBurnRate', 'replyRunway',
    'replyPareto', 'replyDeadStock', 'replyCrossSell', 'replyLifecycle',
    'replyMoM', 'replyQoQ', 'replyYoY', 'replyCAGR', 'replyGrowthRate',
    'replyInvTurnover', 'replyDSI', 'replyDSO', 'replyDPO', 'replyCashCycle',
    'replyStockAlert', 'replyRestock', 'replyVelocity', 'replyHHI',
    'replyAnomaly', 'replyHourlyPattern', 'replyWeekdayPattern', 'replyTimeSlotPattern',
    'replyTopCustomers', 'replyAdvancedDashboard', 'replyScorecard', 'replyBusinessHealth',
    'replyFullReport', 'replyExecutiveSummary',
    'installTriggers', 'dailyStatsTrigger', 'autoBackupTrigger',
    'installSystem', 'setupLineBot', 'testLineBot', 'checkFunctions'
  ];
  const missing = [];
  const present = [];
  required.forEach(function(fn) {
    try {
      const result = eval('typeof ' + fn);
      if (result === 'function') present.push(fn);
      else missing.push(fn);
    } catch (e) { missing.push(fn); }
  });
  console.log('========================================');
  console.log('📋 FUNCTION CHECK v' + CONFIG.VERSION);
  console.log('========================================');
  console.log('Total required:', required.length);
  console.log('Present:', present.length);
  console.log('Missing:', missing.length);
  if (missing.length > 0) {
    console.log('\n❌ MISSING FUNCTIONS:');
    missing.forEach(function(fn) { console.log('  - ' + fn); });
  } else {
    console.log('\n✅ All functions present!');
  }
  return { total: required.length, present: present.length, missing: missing };
}

console.log('🍃 KRATOM POS v' + CONFIG.VERSION + ' — Part 3.5 loaded (Advanced KPIs, Triggers, Install)');