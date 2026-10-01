/**
 * 能力与资源领域服务
 * 统一承载三类能力：
 *  - skill     技能：内置目录安装/卸载
 *  - connector 连接器：Token/Webhook 授权（凭据加密后仅存主进程）
 *  - knowledge 知识库：导入本地目录 → 切分片段 → 关键词索引 → 供任务执行时检索
 * 能力通过 worker.capabilityIds 挂载到 Worker，执行器按挂载情况注入上下文。
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('../store/db');
const bus = require('../runtime/event-bus');
const vault = require('../util/secret-vault');
const workerService = require('./worker-service');
const { SKILL_CATALOG } = require('../data/skill-catalog');
const { createId } = require('../util/id');
const { nowIso } = require('../util/time');
const { fail } = require('../util/errors');

const TYPE_LABEL = { skill: 'Skill', connector: '连接器', knowledge: '知识库' };

/** 连接器目录：现阶段以 Token / Webhook 授权为主，OAuth 待接入真实服务方 */
const CONNECTOR_CATALOG = [
  { key: 'feishu', name: '飞书 / Lark', desc: '群消息、云文档、多维表格', mode: 'token', hint: '企业自建应用的 Tenant Access Token' },
  { key: 'dingtalk', name: '钉钉', desc: '群机器人、工作通知', mode: 'webhook', hint: '群机器人 Webhook 地址或 Access Token' },
  { key: 'wecom', name: '企业微信', desc: '应用消息、通讯录', mode: 'token', hint: '企业应用的 Secret' },
  { key: 'slack', name: 'Slack', desc: '频道消息、斜杠命令', mode: 'token', hint: 'Bot User OAuth Token（xoxb- 开头）' },
  { key: 'github', name: 'GitHub', desc: '仓库、Issue、Pull Request', mode: 'token', hint: 'Personal Access Token（repo 权限）' },
  { key: 'notion', name: 'Notion', desc: '页面与数据库读写', mode: 'token', hint: 'Internal Integration Token' },
  { key: 'smtp', name: '邮件（SMTP）', desc: '发送通知与报表', mode: 'token', hint: 'smtp://user:pass@host:port' },
  { key: 'webhook', name: '通用 Webhook', desc: '推送到任意 HTTP 端点', mode: 'webhook', hint: '接收端的 HTTPS 地址' }
];

// ---- 知识库索引参数：控制导入体量，避免一次性读入过大目录 ----
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.log', '.yml', '.yaml',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.c', '.h', '.cpp',
  '.sql', '.html', '.css', '.xml', '.ini', '.conf', '.sh', '.ps1', '.bat'
]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'coverage', '.idea', '.vscode', 'tmp']);
const MAX_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_CHUNKS = 3000;
const MAX_CHUNKS_PER_FILE = 200;
const CHUNK_SIZE = 400;
const CHUNK_OVERLAP = 80;
const SNIPPET_RADIUS = 60;

// ==================== 通用 ====================

function listAll() {
  return db.all('capabilities');
}

function getOrThrow(id) {
  const capability = db.find('capabilities', id);
  if (!capability) throw fail.notFound('能力不存在');
  return capability;
}

/** 对外输出：连接器只暴露掩码，凭据密文永不下发渲染层 */
function decorate(capability) {
  const { credential, ...rest } = capability;
  return {
    ...rest,
    typeLabel: TYPE_LABEL[capability.type] || capability.type,
    credentialMask: credential ? credential.mask : '',
    credentialMode: credential ? credential.mode : '',
    encrypted: Boolean(credential && credential.sealed.mode === 'encrypted')
  };
}

function publish(capability, eventType) {
  bus.emit(eventType, decorate(capability));
}

function list(filter = {}) {
  let items = listAll();
  if (filter.type) items = items.filter((item) => item.type === filter.type);
  const keyword = String(filter.keyword ?? '').trim().toLowerCase();
  if (keyword) {
    items = items.filter((item) => `${item.title} ${item.desc} ${item.name || ''}`.toLowerCase().includes(keyword));
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items.map(decorate);
}

function stats() {
  const items = listAll();
  const countBy = (type) => items.filter((item) => item.type === type).length;
  return {
    skill: countBy('skill'),
    connector: countBy('connector'),
    authorizedConnector: items.filter((item) => item.type === 'connector' && item.status === 'authorized').length,
    knowledge: countBy('knowledge'),
    chunkTotal: db.count('chunks'),
    encrypted: vault.isEncryptionAvailable()
  };
}

// ==================== Skills ====================

/** 技能市场：目录 + 是否已安装 */
function skillMarket(filter = {}) {
  const installedIds = new Set(listAll().filter((item) => item.type === 'skill').map((item) => item.skillId));
  let items = SKILL_CATALOG.map((skill) => ({ ...skill, installed: installedIds.has(skill.id) }));
  if (filter.category && filter.category !== 'all') {
    items = items.filter((skill) => skill.category === filter.category);
  }
  const keyword = String(filter.keyword ?? '').trim().toLowerCase();
  if (keyword) {
    items = items.filter((skill) => `${skill.title} ${skill.desc} ${skill.author}`.toLowerCase().includes(keyword));
  }
  return { items, total: SKILL_CATALOG.length, installed: installedIds.size };
}

function installSkill(skillId) {
  const skill = SKILL_CATALOG.find((item) => item.id === skillId);
  if (!skill) throw fail.notFound('技能不存在');
  if (listAll().some((item) => item.type === 'skill' && item.skillId === skillId)) {
    throw fail.conflict(`技能「${skill.title}」已安装`);
  }

  const capability = {
    id: createId('cp'),
    type: 'skill',
    skillId: skill.id,
    title: skill.title,
    name: skill.title,
    desc: skill.desc,
    author: skill.author,
    category: skill.category,
    color: skill.color,
    fg: skill.fg,
    downloads: skill.downloads,
    reco: skill.reco,
    status: 'installed',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  db.insert('capabilities', capability);
  publish(capability, 'capability:created');
  return decorate(capability);
}

function uninstall(id) {
  const capability = getOrThrow(id);
  if (capability.type === 'knowledge') {
    db.removeWhere('chunks', { capabilityId: id });
    invalidateChunkIndex();
  }
  // 先摘除（Worker 侧校验链路仍完整）再删除能力本体，失败时能力仍在，可重试
  detachFromWorkers(id);
  db.remove('capabilities', id);
  bus.emit('capability:removed', { id, type: capability.type });
  return { id };
}

// ==================== 连接器 ====================

function connectorCatalog() {
  const records = listAll().filter((item) => item.type === 'connector');
  return CONNECTOR_CATALOG.map((connector) => {
    const record = records.find((item) => item.connectorKey === connector.key);
    return {
      ...connector,
      capabilityId: record ? record.id : null,
      status: record ? record.status : 'unauthorized',
      credentialMask: record && record.credential ? record.credential.mask : ''
    };
  });
}

function authorizeConnector(connectorKey, params = {}) {
  const definition = CONNECTOR_CATALOG.find((item) => item.key === connectorKey);
  if (!definition) throw fail.notFound('连接器不存在');
  const secret = String(params.secret ?? '').trim();
  if (!secret) throw fail.validation('请填写访问凭据');
  if (secret.length > 2048) throw fail.validation('凭据长度超出限制');

  const existing = listAll().find((item) => item.type === 'connector' && item.connectorKey === connectorKey);
  const sealed = vault.seal(secret);
  const credential = { sealed, mask: vault.mask(secret), mode: definition.mode };

  // 系统密钥链不可用时凭据仅做 base64 编码（伪加密），必须让用户知情
  if (sealed.mode !== 'encrypted') {
    bus.emit('app:notice', {
      level: 'warning',
      title: '凭据未获得系统级加密保护',
      body: `当前系统密钥链不可用，「${definition.name}」的凭据仅做了基础编码存储。请检查 Windows 凭据服务是否正常，敏感凭据建议改用受保护的账户。`
    });
  }

  if (existing) {
    const next = { ...existing, credential, status: 'authorized', updatedAt: nowIso() };
    db.update('capabilities', existing.id, next);
    publish(next, 'capability:updated');
    return decorate(next);
  }

  const capability = {
    id: createId('cp'),
    type: 'connector',
    connectorKey,
    title: definition.name,
    name: definition.name,
    desc: definition.desc,
    mode: definition.mode,
    credential,
    status: 'authorized',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  db.insert('capabilities', capability);
  publish(capability, 'capability:created');
  return decorate(capability);
}

function revokeConnector(id) {
  const capability = getOrThrow(id);
  if (capability.type !== 'connector') throw fail.invalidState('该能力不是连接器');
  const next = { ...capability, credential: null, status: 'unauthorized', updatedAt: nowIso() };
  db.update('capabilities', id, next);
  publish(next, 'capability:updated');
  return decorate(next);
}

// ==================== 知识库 ====================

async function normalizeDir(dir) {
  const target = path.resolve(String(dir ?? '').trim());
  if (!target) throw fail.validation('请选择要导入的目录');
  let stat;
  try {
    stat = await fs.promises.stat(target);
  } catch (error) {
    throw fail.validation('目录不存在或不可访问');
  }
  if (!stat.isDirectory()) throw fail.validation('请选择目录而不是文件');
  return target;
}

/** 全链路 fs.promises 异步扫描：每次 await 都让出事件循环，
 *  大目录导入（上限 200×512KB）期间主进程的 IPC/HTTP/任务运行时不被阻塞 */
async function scanFiles(dir) {
  const files = [];
  const walk = async (current) => {
    if (files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        if ((await fs.promises.stat(full)).size > MAX_FILE_BYTES) continue;
      } catch (error) {
        continue;
      }
      files.push(full);
    }
  };
  await walk(dir);
  return files;
}

/** 定长切分 + 重叠，保证跨片段的语义不被硬切断 */
function chunkText(text) {
  const normalized = String(text).replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const chunks = [];
  let start = 0;
  while (start < normalized.length && chunks.length < MAX_CHUNKS_PER_FILE) {
    const end = Math.min(start + CHUNK_SIZE, normalized.length);
    const slice = normalized.slice(start, end).trim();
    if (slice) chunks.push(slice);
    if (end >= normalized.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

/** 关键词切分：英文/数字按词，中文按 2 字粒度（无需分词器，离线可用） */
function tokenize(text) {
  const lower = String(text).toLowerCase();
  const tokens = new Set();
  (lower.match(/[a-z0-9_]{2,}/g) || []).forEach((token) => tokens.add(token));
  (lower.match(/[\u4e00-\u9fa5]+/g) || []).forEach((run) => {
    if (run.length === 1) tokens.add(run);
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
  });
  return [...tokens];
}

async function indexDirectory(capabilityId, dir) {
  const files = await scanFiles(dir);
  if (!files.length) throw fail.validation('该目录下没有可索引的文本文件');

  const chunks = [];
  for (const file of files) {
    if (chunks.length >= MAX_CHUNKS) break;
    let text;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch (error) {
      continue;
    }
    chunkText(text)
      .slice(0, MAX_CHUNKS - chunks.length)
      .forEach((slice, order) => {
        chunks.push({
          id: createId('ch'),
          capabilityId,
          file: path.basename(file),
          path: file,
          order,
          text: slice
        });
      });
  }

  db.removeWhere('chunks', { capabilityId });
  db.insertMany('chunks', chunks); // 批量写盘：逐条 insert 在数千片段时是 O(N²)
  invalidateChunkIndex();
  return { fileCount: files.length, chunkCount: chunks.length, dir };
}

async function createKnowledge(params = {}) {
  const name = String(params.name ?? '').trim();
  if (!name) throw fail.validation('请填写知识库名称');
  if (name.length > 30) throw fail.validation('名称最多 30 个字符');
  const dir = await normalizeDir(params.dir);

  const capability = {
    id: createId('cp'),
    type: 'knowledge',
    title: name,
    name,
    desc: String(params.desc ?? '').trim().slice(0, 100),
    dir,
    source: null,
    status: 'indexed',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  // 先索引、后入库：索引失败（如目录没有可索引文本）时不能留下 status=indexed 但没有任何片段的幽灵知识库
  let source;
  try {
    source = await indexDirectory(capability.id, dir);
  } catch (error) {
    db.removeWhere('chunks', { capabilityId: capability.id });
    invalidateChunkIndex();
    throw error;
  }
  const next = { ...capability, source, updatedAt: nowIso() };
  db.insert('capabilities', next);
  publish(next, 'capability:created');
  return decorate(next);
}

async function reindexKnowledge(id) {
  const capability = getOrThrow(id);
  if (capability.type !== 'knowledge') throw fail.invalidState('该能力不是知识库');
  const source = await indexDirectory(id, capability.dir);
  const next = { ...capability, source, status: 'indexed', updatedAt: nowIso() };
  db.update('capabilities', id, next);
  publish(next, 'capability:updated');
  return decorate(next);
}

function makeSnippet(text, tokens) {
  const lower = text.toLowerCase();
  let index = -1;
  tokens.some((token) => {
    index = lower.indexOf(token);
    return index >= 0;
  });
  if (index < 0) return text.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** 在指定知识库内检索 */
function searchKnowledge(capabilityId, keyword, limit = 5) {
  const capability = getOrThrow(capabilityId);
  if (capability.type !== 'knowledge') throw fail.invalidState('该能力不是知识库');
  const query = String(keyword ?? '').trim();
  if (!query) throw fail.validation('请输入检索关键词');
  const tokens = tokenize(query);
  if (!tokens.length) return [];

  const chunks = getChunkIndex().get(capabilityId) || [];
  return chunks
    .map((chunk) => {
      const lower = chunk.text.toLowerCase();
      const score = tokens.reduce((total, token) => (lower.includes(token) ? total + Math.max(1, token.length - 1) : total), 0);
      return { chunk, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((hit) => ({
      library: capability.title,
      capabilityId,
      file: hit.chunk.file,
      score: hit.score,
      snippet: makeSnippet(hit.chunk.text, tokens)
    }));
}

/** chunks 内存索引：capabilityId → 片段数组。任何 chunks 变更后必须 invalidateChunkIndex()。
 *  检索热路径（任务每步一次）用它替代 db.all('chunks') 的整集合深拷贝。 */
let chunkIndex = null;

function invalidateChunkIndex() {
  chunkIndex = null;
}

function getChunkIndex() {
  if (!chunkIndex) {
    chunkIndex = new Map();
    db.all('chunks').forEach((chunk) => {
      if (!chunkIndex.has(chunk.capabilityId)) chunkIndex.set(chunk.capabilityId, []);
      chunkIndex.get(chunk.capabilityId).push(chunk);
    });
  }
  return chunkIndex;
}

/** Worker 已挂载的能力分组（执行器注入用） */
function resolveWorkerCapabilities(workerId) {
  const worker = db.find('workers', workerId);
  if (!worker) return { skills: [], connectors: [], knowledge: [] };
  const mounted = (worker.capabilityIds || [])
    .map((id) => db.find('capabilities', id))
    .filter(Boolean);
  return {
    skills: mounted.filter((item) => item.type === 'skill').map(decorate),
    connectors: mounted.filter((item) => item.type === 'connector' && item.status === 'authorized').map(decorate),
    knowledge: mounted.filter((item) => item.type === 'knowledge').map(decorate)
  };
}

/** 按 Worker 挂载的知识库检索：任务执行时按需调用 */
function searchForWorker(workerId, query, limit = 3) {
  const { knowledge } = resolveWorkerCapabilities(workerId);
  if (!knowledge.length) return [];
  const hits = [];
  knowledge.forEach((library) => {
    try {
      searchKnowledge(library.id, query, limit).forEach((hit) => hits.push(hit));
    } catch (error) {
      // 单个库检索失败不影响整体执行
    }
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 能力被删除时从所有 Worker 上摘除，避免悬空引用（走 worker-service 统一校验、落库与事件广播） */
function detachFromWorkers(capabilityId) {
  // 摘除不走 updateWorker 的全量校验（O13）：卸载是有意的移除，
  // 不能因某个 Worker 挂载列表中存在其它悬空能力 ID 而被「所选能力中包含已卸载的项」反向阻断
  db.all('workers')
    .filter((worker) => (worker.capabilityIds || []).includes(capabilityId))
    .forEach((worker) => {
      const next = db.update('workers', worker.id, {
        ...worker,
        capabilityIds: worker.capabilityIds.filter((id) => id !== capabilityId),
        updatedAt: nowIso()
      });
      bus.emit('worker:updated', workerService.decorateWorker(next));
    });
}

function mountedWorkers(capabilityId) {
  return db.all('workers').filter((worker) => (worker.capabilityIds || []).includes(capabilityId)).length;
}

module.exports = {
  TYPE_LABEL,
  CONNECTOR_CATALOG,
  list,
  stats,
  skillMarket,
  installSkill,
  uninstall,
  connectorCatalog,
  authorizeConnector,
  revokeConnector,
  createKnowledge,
  reindexKnowledge,
  searchKnowledge,
  searchForWorker,
  resolveWorkerCapabilities,
  mountedWorkers
};