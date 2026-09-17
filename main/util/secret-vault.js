/**
 * 凭据保险箱
 * 优先使用 Electron safeStorage（受操作系统密钥链保护）；在不可用环境（如纯 Node 测试）降级为
 * base64 编码并标记模式，保证链路可跑通，同时让调用方能够识别当前保护级别。
 */

const electron = (() => {
  try {
    return require('electron');
  } catch (error) {
    return null;
  }
})();

const safeStorage = electron && typeof electron === 'object' ? electron.safeStorage : null;

function isEncryptionAvailable() {
  try {
    return Boolean(safeStorage && safeStorage.isEncryptionAvailable());
  } catch (error) {
    return false;
  }
}

function seal(plain) {
  const text = String(plain ?? '');
  if (isEncryptionAvailable()) {
    return { mode: 'encrypted', value: safeStorage.encryptString(text).toString('base64') };
  }
  return { mode: 'base64', value: Buffer.from(text, 'utf8').toString('base64') };
}

function open(sealed) {
  if (!sealed || !sealed.value) return '';
  if (sealed.mode === 'encrypted' && safeStorage) {
    return safeStorage.decryptString(Buffer.from(sealed.value, 'base64'));
  }
  return Buffer.from(sealed.value, 'base64').toString('utf8');
}

/** 仅用于界面展示的掩码，绝不回传明文 */
function mask(plain) {
  const text = String(plain ?? '');
  if (!text) return '';
  return text.length <= 4 ? '••••' : `••••${text.slice(-4)}`;
}

module.exports = { isEncryptionAvailable, seal, open, mask };