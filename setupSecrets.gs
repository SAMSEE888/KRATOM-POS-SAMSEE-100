/**
* ============================================================================
* 🔐 KRATOM POS · setupSecrets.gs
* ============================================================================
* รันฟังก์ชัน setupSecrets() ครั้งแรกครั้งเดียว หลังวาง Code.gs
*
* วิธีใช้:
* 1. ใน Apps Script Editor → เลือก setupSecrets
* 2. กด Run
* 3. ใส่ค่าตาม prompt ที่ถาม
* 4. เสร็จแล้วไปรัน installSystem() ต่อ
*
* ⚠️ ค่าที่กรอกจะถูกเก็บใน Script Properties (ปลอดภัย ไม่ hardcode)
* ============================================================================
*/

function setupSecrets() {
const ui = SpreadsheetApp.getUi();
const props = PropertiesService.getScriptProperties();

const fields = [
{ key: 'LINE_CHANNEL_ACCESS_TOKEN', label: 'LINE Channel Access Token', help: 'จาก LINE Developers > Messaging API' },
{ key: 'LINE_CHANNEL_SECRET', label: 'LINE Channel Secret', help: 'จาก LINE Developers > Basic Settings' },
{ key: 'LINE_ADMIN_USER_ID', label: 'LINE Admin User ID', help: 'LINE User ID ของแอดมิน (U...) หรือグループ ID (C...)' },
{ key: 'API_KEY', label: 'API Key (สำหรับ Web App)', help: 'ตั้งค่ารหัสลับเอง เช่น "kratom_" + 32 ตัวอักษรสุ่ม (ไม่บังคับ เว้นว่างได้)' }
];

let summary = '🔐 KRATOM POS · Setup Secrets\n\n';
const updates = {};

fields.forEach(field => {
const current = props.getProperty(field.key) || '';
const masked = current ? current.slice(0, 6) + '...' + current.slice(-4) : '(ว่าง)';

const response = ui.prompt(
field.label + (current ? ' [มีอยู่แล้ว: ' + masked + ']' : ''),
field.help + '\n\n' + (current ? 'เว้นว่างเพื่อใช้ค่าเดิม' : 'กรอกค่าใหม่'),
ui.ButtonSet.OK_CANCEL
);

if (response.getSelectedButton() === ui.Button.OK) {
const value = response.getResponseText().trim();
if (value) {
updates[field.key] = value;
summary += '✅ ' + field.label + ': ตั้งค่าใหม่\n';
} else if (current) {
summary += '⏭️ ' + field.label + ': ใช้ค่าเดิม\n';
} else {
summary += '⏭️ ' + field.label + ': ข้าม\n';
}
}
});

// Save
Object.keys(updates).forEach(k => props.setProperty(k, updates[k]));

// Auto-generate API key if left blank and API requires it
if (!props.getProperty('API_KEY')) {
const auto = 'kratom_' + Utilities.getUuid().replace(/-/g, '').slice(0, 32);
props.setProperty('API_KEY', auto);
summary += '\n🔑 Auto-generated API Key: ' + auto + '\n';
summary += '(เก็บไว้ใช้กับ index.html/dashboard.html)\n';
}

summary += '\n📋 ขั้นต่อไป:\n';
summary += '1. Run > installSystem\n';
summary += '2. Deploy > New deployment > Web app\n';
summary += '3. Copy URL + API Key ไปใส่ใน HTML\n';

ui.alert('Setup Complete', summary, ui.ButtonSet.OK);
console.log(summary);
}

function showCurrentSecrets() {
const props = PropertiesService.getScriptProperties().getProperties();
const mask = v => v ? v.slice(0, 6) + '...' + v.slice(-4) : '(ว่าง)';
const info = {
LINE_TOKEN: mask(props.LINE_CHANNEL_ACCESS_TOKEN),
LINE_SECRET: mask(props.LINE_CHANNEL_SECRET),
ADMIN_ID: mask(props.LINE_ADMIN_USER_ID),
API_KEY: mask(props.API_KEY)
};
console.log(JSON.stringify(info, null, 2));
try {
SpreadsheetApp.getUi().alert('Current Secrets', JSON.stringify(info, null, 2), SpreadsheetApp.getUi().ButtonSet.OK);
} catch (e) {}
return info;
}

function clearSecrets() {
const props = PropertiesService.getScriptProperties();
['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'LINE_ADMIN_USER_ID', 'API_KEY'].forEach(k => props.deleteProperty(k));
console.log('✅ All secrets cleared');
}
