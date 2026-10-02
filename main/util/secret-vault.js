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

// 解密失败只告警一次，避免 http-server 认证等高频调用方把通知/日志刷爆；解密恢复成功后复位
let decryptBroken = false;

/** 解密失败告警（BUG-17）：跨机器迁移 userData 或 DPAPI 损坏时 decryptString 会抛错，
 *  不捕获会沿调用链导致 http-server 认证 500、automation 复制命令 INTERNAL。 */
function warnDecryptFailure(error) {
  if (decryptBroken) return;
  decryptBroken = true;
  console.error('[secret-vault] 凭据解密失败（密文损坏或跨机器迁移）:', error?.message || error);
  // 惰性 require 避免与上层模块的潜在加载环；event-bus 无依赖不会失败
  try {
    require('../runtime/event-bus').emit('app:notice', {
      level: 'error',
      title: '凭据解密失败',
      message: '已保存的凭据无法解密（可能因系统密钥损坏或数据目录被迁移），请重新在对应功能中填写密钥。'
    });
  } catch (notifyError) {
    // 总线不可用时（如纯 Node 测试环境）仅保留日志
  }
}

function isEncryptionAvailable() {
  try {
    return Boolean(safeStorage && safeStorage.isEncryptionAvailable());
  } catch (error) {
    return false;
  }
}

function seal(plain) {
  const text = String(plain ?? '');
  // 版本字段（SEC-8）：密文结构带格式版本，未来 DPAPI 迁移或算法升级可按 v 分支灰度；
  // open 对缺失 v 的既有数据按 v1 兼容读取，无迁移成本
  if (isEncryptionAvailable()) {
    return { mode: 'encrypted', v: 1, value: safeStorage.encryptString(text).toString('base64') };
  }
  return { mode: 'base64', v: 1, value: Buffer.from(text, 'utf8').toString('base64') };
}

function open(sealed) {
  if (!sealed || !sealed.value) return '';
  try {
    if (sealed.mode === 'encrypted' && safeStorage) {
      const plain = safeStorage.decryptString(Buffer.from(sealed.value, 'base64'));
      decryptBroken = false; // 解密恢复成功，允许后续失败再次告警
      return plain;
    }
    return Buffer.from(sealed.value, 'base64').toString('utf8');
  } catch (error) {
    // 降级返回空串而非向上抛错：调用方（http-server 认证、automation 命令拼装）按"未配置"分支走，
    // 服务保持可用；仅首次失败推送告警引导用户重新填写密钥（BUG-17）
    warnDecryptFailure(error);
    return '';
  }
}

/** 仅用于界面展示的掩码，绝不回传明文 */
function mask(plain) {
  const text = String(plain ?? '');
  if (!text) return '';
  return text.length <= 4 ? '••••' : `••••${text.slice(-4)}`;
}

module.exports = { isEncryptionAvailable, seal, open, mask };