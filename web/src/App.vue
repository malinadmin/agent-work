<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import DiffPreview from './DiffPreview.vue';
import { themes, readTheme, saveTheme } from './theme.js';
const theme = ref(readTheme());
function changeTheme(event) { theme.value = saveTheme(event.target.value); }
import { Maximize2, Terminal, Plus, MessageSquare, Bot, Settings2, ArrowUp, ArrowRight, PanelRightClose, PanelRightOpen, FolderOpen, GitBranch, FileCode2, Radio, RefreshCw, Search, Check, Circle, Square, Layers, Cpu, Clock3, ChevronDown, ChevronRight, Pencil, Trash2, X, ShieldCheck } from '@lucide/vue';
const page = ref('chat'), panel = ref(true), tab = ref('changes'), agents = ref([]), sessions = ref([]), query = ref(''), active = ref(null), messages = ref([]), prompt = ref(''), selectedAgent = ref('codex'), sending = ref(false), error = ref(''), notice = ref(''), status = ref({ config: {}, logs: [], jobs: [], robotStatus: 'stopped' }), diff = ref({}), loadingHistory = ref(false), loading = ref(true), form = ref({}), transcript = ref(null), jobId = ref(null);
const online = ref(false), robotConflict = ref(null), robotOperating = ref(false), executionUpdating = ref(false);
const diffDialog = ref(null);
function openDiffPreview() { if (!diffDialog.value?.open) diffDialog.value?.showModal(); }
const detecting = ref(false), agentsCheckedAt = ref(null), agentsError = ref('');
async function refreshAgents() {
  if (detecting.value) return;
  detecting.value = true;
  try { agents.value = await api('/agents'); agentsCheckedAt.value = Date.now(); agentsError.value = ''; }
  catch (e) { agentsError.value = '智能体环境检测失败：' + e.message; }
  finally { detecting.value = false; }
}
watch(page, value => { if (value === 'agents') refreshAgents(); });
const permissionDisabled = computed(() => loading.value || !online.value || workspaceBusy.value || status.value.configUpdating || executionUpdating.value || sending.value || status.value.busy || status.value.robotStatus !== 'stopped' || status.value.robotExternal || status.value.robotActionPending);
const permissionHint = computed(() => status.value.robotStatus !== 'stopped' || status.value.robotExternal ? '请先停止机器人后切换权限' : status.value.busy || sending.value ? '任务执行期间不能切换权限' : '切换后自动保存，用于下一次任务');
const workspaceBusy = ref(false), workspaceEditor = ref(null), workspaceForm = ref({ name: '', workdir: '', model: '', sandbox: 'read-only' }), workspaceRemoval = ref(null);
const workspaceDrafts = new Map();
const expandedWorkspaces = ref(new Set()), workspacesPage = ref(null);
const workspaceData = computed(() => status.value.workspaces || { activeId: '', items: [] });
const currentWorkspace = computed(() => workspaceData.value.items.find(w => w.id === workspaceData.value.activeId));
const workspaceDisabled = computed(() => loading.value || !online.value || workspaceBusy.value || executionUpdating.value || sending.value || loadingHistory.value || status.value.busy || status.value.configUpdating || status.value.robotStatus !== 'stopped' || status.value.robotExternal || status.value.robotActionPending);
const unassignedSessions = computed(() => sessions.value.filter(s => !s.workspaceId));
const workspaceHistory = (id) => filteredSessions.value.filter(session => session.workspaceId === id);
const modelCatalog = ref({ models: [], defaultModel: '', cacheAvailable: false }), customModelOpen = ref(false), customModel = ref('');
const modelOptions = computed(() => {
  const options = [...modelCatalog.value.models];
  const current = status.value.config.model;
  if (current && !options.some(model => model.id === current)) options.unshift({ id: current, name: current, source: '当前配置' });
  return options;
});
const modelDisabled = computed(() => permissionDisabled.value || selectedAgent.value !== 'codex');
let timer, polling = false;
function shortcut(event) { if (diffDialog.value?.open) return; if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); newChat(); } }
const agent = computed(() => agents.value.find(a => a.id === selectedAgent.value));
const filteredSessions = computed(() => sessions.value.filter(s => (s.title + s.agent).toLowerCase().includes(query.value.toLowerCase())));
const files = computed(() => (diff.value.status || '').split('\n').filter(Boolean));
const robotLabels = { stopped: '未启动', starting: '连接中', running: '运行中', stopping: '等待任务完成' };
const workdirName = computed(() => currentWorkspace.value?.name || '本地工作区');
async function api(path, data) {
  const response = await fetch('/api' + path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) { const error = new Error(result.error || '请求失败'); error.code = result.code; error.pid = result.pid; throw error; } return result;
}
function setForm() { const c = status.value.config; form.value = { clientId: c.clientId || '', clientSecret: '', allowedUsers: (c.allowedUsers || []).join(', '), allowedConversations: (c.allowedConversations || []).join(', '), workdir: c.workdir || '', sandbox: c.sandbox || 'read-only', model: c.model || '' }; }
async function scroll() { await nextTick(); if (transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight; }
async function refreshSessions() { sessions.value = await api('/sessions'); }
async function refreshDiff() { diff.value = await api('/diff'); }
async function poll() {
  if (polling) return; polling = true;
  try {
    status.value = await api('/status'); online.value = true;
    if (!agentsCheckedAt.value || Date.now() - agentsCheckedAt.value > 15000) void refreshAgents();
    if (jobId.value) {
      const job = status.value.jobs.find(j => j.id === jobId.value);
      if (job && job.status !== 'running') {
        messages.value.push({ role: 'assistant', text: job.text, failed: job.status === 'failed' });
        if (job.sessionId) active.value = { ...(active.value || {}), id: job.sessionId, key: `codex:${job.sessionId}`, agent: 'codex', title: messages.value.find(m => m.role === 'user')?.text.slice(0, 50) };
        sending.value = false; jobId.value = null; await scroll(); await Promise.all([refreshSessions(), refreshDiff()]);
      }
    }
  } catch (e) { online.value = false; error.value = '本地服务连接中断：' + e.message; } finally { polling = false; }
}
async function initialize() {
  loading.value = true;
  try { await poll(); expandedWorkspaces.value.add(workspaceData.value.activeId); setForm(); await Promise.all([refreshAgents(), api('/models').then(data => { modelCatalog.value = data; }), refreshSessions(), refreshDiff()]); }
  catch (e) { error.value = e.message; } finally { loading.value = false; }
}
function newChat() { if (sending.value || loadingHistory.value || workspaceBusy.value) return; active.value = null; messages.value = []; selectedAgent.value = 'codex'; page.value = 'chat'; prompt.value = ''; }
async function openSession(session) {
  if (workspaceDisabled.value) return;
  if (session.workspaceId && session.workspaceId !== workspaceData.value.activeId) await switchWorkspace(session.workspaceId);
  if (!session.workspaceId) { error.value = '请先将该会话所在目录添加为工作空间'; return; }
  if (session.workspaceId !== workspaceData.value.activeId) return;
  loadingHistory.value = true; error.value = '';
  try { const data = await api('/sessions/' + encodeURIComponent(session.key)); active.value = data; messages.value = data.messages; selectedAgent.value = data.agent; page.value = 'chat'; await scroll(); }
  catch (e) { error.value = e.message; } finally { loadingHistory.value = false; }
}
async function send() {
  if (!prompt.value.trim() || sending.value || loadingHistory.value || executionUpdating.value || workspaceBusy.value) return;
  const text = prompt.value; sending.value = true; error.value = '';
  try {
    const job = await api('/chat', { prompt: text, agent: selectedAgent.value, sessionId: active.value?.id, workspaceId: workspaceData.value.activeId });
    messages.value.push({ role: 'user', text }); prompt.value = ''; jobId.value = job.id; await scroll();
  } catch (e) { error.value = e.message; sending.value = false; }
}
function rememberWorkspace() {
  workspaceDrafts.set(workspaceData.value.activeId, { active: active.value, messages: messages.value, prompt: prompt.value, agent: selectedAgent.value });
}
function restoreWorkspace(id) {
  const draft = workspaceDrafts.get(id);
  active.value = draft?.active || null; messages.value = draft?.messages || []; prompt.value = draft?.prompt || ''; selectedAgent.value = draft?.agent || 'codex';
  customModelOpen.value = false; query.value = '';
}
async function applyWorkspaceResult(result, previousId) {
  status.value = { ...status.value, workspaces: { activeId: result.activeId, items: result.items }, config: result.config };
  if (previousId !== result.activeId) restoreWorkspace(result.activeId);
  expandedWorkspaces.value.add(result.activeId);
  setForm(); await Promise.all([refreshSessions(), refreshDiff()]);
}
async function switchWorkspace(id) {
  if (workspaceDisabled.value) return;
  if (id === workspaceData.value.activeId) { expandedWorkspaces.value.add(id); page.value = 'chat'; return; }
  const previousId = workspaceData.value.activeId; rememberWorkspace(); workspaceBusy.value = true; error.value = '';
  try { const result = await api('/workspaces/select', { id }); await applyWorkspaceResult(result, previousId); page.value = 'chat'; if (window.innerWidth <= 760) panel.value = false; }
  catch (e) { error.value = e.message; }
  finally { workspaceBusy.value = false; }
}
async function toggleWorkspace(id) {
  const wasExpanded = expandedWorkspaces.value.has(id);
  if (id !== workspaceData.value.activeId) {
    if (workspaceDisabled.value) return;
    await switchWorkspace(id);
    if (id !== workspaceData.value.activeId) return;
  }
  if (wasExpanded) expandedWorkspaces.value.delete(id);
  else expandedWorkspaces.value.add(id);
}
async function newWorkspaceChat(id) {
  if (workspaceDisabled.value) return;
  if (id !== workspaceData.value.activeId) await switchWorkspace(id);
  if (id === workspaceData.value.activeId) newChat();
}
async function editWorkspace(workspace, directory = '') {
  workspaceEditor.value = workspace?.id || 'new'; workspaceRemoval.value = null;
  workspaceForm.value = workspace ? { ...workspace } : { name: '', workdir: directory, model: '', sandbox: 'read-only' };
  page.value = 'workspaces';
  await nextTick();
  workspacesPage.value?.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  workspacesPage.value?.querySelector('.workspace-editor input')?.focus({ preventScroll: true });
}
async function saveWorkspace() {
  if (workspaceDisabled.value) return;
  const previousId = workspaceData.value.activeId; rememberWorkspace(); workspaceBusy.value = true; error.value = '';
  try {
    const result = await api('/workspaces/' + (workspaceEditor.value === 'new' ? 'add' : 'update'), workspaceForm.value);
    await applyWorkspaceResult(result, previousId); workspaceEditor.value = null; notice.value = '工作空间已保存';
  } catch (e) { error.value = e.message; }
  finally { workspaceBusy.value = false; }
}
async function removeWorkspace(id) {
  if (workspaceDisabled.value) return;
  const previousId = workspaceData.value.activeId; rememberWorkspace(); workspaceBusy.value = true; error.value = '';
  try {
    const result = await api('/workspaces/remove', { id }); workspaceDrafts.delete(id); expandedWorkspaces.value.delete(id);
    await applyWorkspaceResult(result, previousId); workspaceRemoval.value = null; notice.value = '已移除工作空间，项目文件和原始会话记录保留';
  } catch (e) { error.value = e.message; }
  finally { workspaceBusy.value = false; }
}
async function changePermission(event) {
  const select = event.target;
  const previous = status.value.config.sandbox || 'read-only';
  const sandbox = select.value;
  if (permissionDisabled.value || sandbox === previous) { select.value = previous; return; }
  executionUpdating.value = true; error.value = '';
  try {
    const config = await api('/config', { sandbox });
    status.value.config = config; form.value.sandbox = config.sandbox;
    notice.value = config.sandbox === 'workspace-write' ? '已切换为读写工作目录，下一次任务生效' : '已切换为只读模式，下一次任务生效';
  } catch (e) {
    select.value = previous; error.value = e.message;
  } finally { executionUpdating.value = false; }
}
async function changeModel(event) {
  const select = event.target;
  const previous = status.value.config.model || '';
  if (modelDisabled.value) { select.value = previous; return; }
  if (select.value === '__custom__') { customModel.value = previous; customModelOpen.value = true; return; }
  customModelOpen.value = false;
  await saveModel(select.value, select);
}
async function saveModel(value, select) {
  if (modelDisabled.value) return;
  const previous = status.value.config.model || '';
  const model = value.trim();
  if (model === previous) { customModelOpen.value = false; return; }
  executionUpdating.value = true; error.value = '';
  try {
    const config = await api('/config', { model });
    status.value.config = config; form.value.model = config.model; customModelOpen.value = false;
    notice.value = model ? `已切换模型为 ${model}，下一次任务生效` : '已切换为沿用本机模型配置，下一次任务生效';
  } catch (e) { if (select) select.value = previous; error.value = e.message; }
  finally { executionUpdating.value = false; }
}
async function saveConfig() {
  try { await api('/config', form.value); await poll(); setForm(); notice.value = '配置已保存，下一次启动机器人时生效'; }
  catch (e) { error.value = e.message; }
}
async function robotAction(action, force = false) {
  if (robotOperating.value) return;
  robotOperating.value = true; error.value = '';
  try {
    await api('/robot/' + action, { force }); robotConflict.value = null;
    panel.value = true; tab.value = 'logs'; await poll();
  } catch (e) {
    if (e.code === 'ROBOT_RUNNING') robotConflict.value = { message: e.message, pid: e.pid };
    else error.value = e.message;
  } finally { robotOperating.value = false; }
}
async function detect() { await refreshAgents(); if (!agentsError.value) notice.value = '已重新检测本地智能体环境'; }
function time(value) { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }); }
function date(value) { return new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }); }
function keydown(event) { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); } }
onMounted(async () => { if (window.innerWidth <= 760) panel.value = false; window.addEventListener('keydown', shortcut); await initialize(); timer = setInterval(poll, 1800); });
onUnmounted(() => { clearInterval(timer); window.removeEventListener('keydown', shortcut); });
</script>

<template>
  <div class="studio-shell">
    <aside class="sidebar">
      <a class="brand" href="/" aria-label="AW(智能体工作台) 首页"><span class="brand-icon"><Terminal :size="20" /></span><span>AW<small>智能体工作台</small></span></a>
      <nav class="main-nav workspace-global-nav">
        <button :class="{ selected: page === 'workspaces' }" @click="page = 'workspaces'"><FolderOpen :size="17" /> 工作空间管理 <span class="count">{{ workspaceData.items.length }}</span></button>
        <button :class="{ selected: page === 'agents' }" @click="page = 'agents'"><Layers :size="17" /> 智能体环境 <span class="count">{{ agents.filter(a => a.installed).length }}</span></button>
        <button :class="{ selected: page === 'robot' }" @click="page = 'robot'"><Bot :size="17" /> 钉钉机器人 <span class="dot" :class="{ live: status.robotStatus === 'running' }"></span></button>
      </nav>
      <div class="history-heading workspace-tree-heading"><span>工作空间</span><div><button class="icon-btn" aria-label="刷新会话" @click="refreshSessions().catch(e => error = e.message)"><RefreshCw :size="13" /></button><button class="icon-btn" aria-label="添加工作空间" :disabled="workspaceDisabled" @click="editWorkspace()"><Plus :size="16" /></button></div></div>
      <div class="history-search"><Search :size="14" /><input v-model="query" placeholder="搜索项目会话…" aria-label="搜索历史会话" /></div>
      <div class="workspace-tree">
        <p class="sidebar-hint" v-if="loading">正在读取工作空间…</p>
        <section v-for="workspace in workspaceData.items" :key="workspace.id" class="workspace-group" :class="{ 'is-current': workspace.id === workspaceData.activeId }">
          <button class="workspace-tree-item" :aria-expanded="expandedWorkspaces.has(workspace.id)" :title="workspace.workdir" @click="toggleWorkspace(workspace.id)" :disabled="workspaceDisabled && workspace.id !== workspaceData.activeId"><ChevronDown v-if="expandedWorkspaces.has(workspace.id)" :size="13" /><ChevronRight v-else :size="13" /><FolderOpen :size="16" /><span>{{ workspace.name }}</span><small>{{ workspaceHistory(workspace.id).length }}</small></button>
          <div v-if="expandedWorkspaces.has(workspace.id)" class="workspace-sessions">
            <div class="workspace-directory" :title="workspace.workdir">{{ workspace.workdir }}</div>
            <button class="workspace-new-chat" @click="newWorkspaceChat(workspace.id)" :disabled="workspaceDisabled"><Plus :size="14" /> 新建会话</button>
            <p v-if="!workspaceHistory(workspace.id).length" class="sidebar-hint">{{ query ? '没有匹配的项目会话' : '这个项目还没有本地会话' }}</p>
            <button v-for="session in workspaceHistory(workspace.id)" :key="session.key" class="history-item" :class="{ active: active?.key === session.key && page === 'chat' }" @click="openSession(session)" :disabled="workspaceDisabled"><MessageSquare :size="14" /><div><span>{{ session.title }}</span><small>{{ session.agent === 'codex' ? 'Codex' : 'Claude Code' }}<i>·</i>{{ date(session.modified) }}</small></div></button>
          </div>
        </section>
        <button v-if="unassignedSessions.length" class="unassigned-history" @click="page = 'workspaces'"><Clock3 :size="14" /> 其他本地会话 <span>{{ unassignedSessions.length }}</span></button>
      </div>
      <div class="sidebar-bottom"><div class="local-indicator"><span class="dot live"></span> 本地运行 <span>127.0.0.1</span></div><button class="workspace" @click="page = 'workspaces'"><span class="workspace-icon"><FolderOpen :size="16" /></span><div>{{ workdirName }}<small>当前工作空间</small></div><Settings2 :size="15" /></button></div>
    </aside>

    <div class="main-shell">
      <header class="topbar"><div class="breadcrumb"><button class="breadcrumb-workspace" @click="page = 'workspaces'">{{ currentWorkspace?.name || '工作空间' }}</button><span>/</span><strong>{{ page === 'chat' ? '对话工作台' : page === 'workspaces' ? '工作空间管理' : page === 'agents' ? '智能体环境' : '钉钉机器人' }}</strong></div><div class="topbar-actions"><label class="theme-picker" title="切换界面主题"><span class="theme-swatch" aria-hidden="true"></span><select :value="theme" @change="changeTheme" aria-label="切换主题"><option v-for="item in themes" :key="item.id" :value="item.id">{{ item.name }}</option></select></label><span class="local-badge"><ShieldCheck :size="13" /> Local first</span><button class="icon-btn" @click="panel = !panel" :aria-label="panel ? '收起侧栏' : '展开侧栏'"><PanelRightClose v-if="panel" :size="18" /><PanelRightOpen v-else :size="18" /></button></div></header>
      <div v-if="error" class="banner error" role="alert">{{ error }}<button @click="error = ''" aria-label="关闭错误"><X :size="15" /></button></div>
      <div v-if="notice" class="banner success" role="status">{{ notice }}<button @click="notice = ''" aria-label="关闭提示"><X :size="15" /></button></div>
      <div class="content-shell">
        <main class="main-content">
          <template v-if="page === 'chat'">
            <div class="chat-toolbar"><div class="agent-label"><span class="agent-symbol">⌘</span><strong>{{ agent?.name || 'Codex' }}</strong><span class="pill">{{ agent?.chat ? '本地 CLI' : '历史记录' }}</span></div><span class="muted text-xs">{{ active ? '本地会话 · ' + active.id.slice(0, 8) : '新会话' }}</span></div>
            <div ref="transcript" class="transcript" :class="{ empty: !messages.length }">
              <div v-if="!messages.length" class="welcome">
                <div class="welcome-mark"><Terminal :size="31" stroke-width="1.8" /><span class="spark">✦</span></div>
                <div class="eyebrow">YOUR LOCAL CODING COMPANION</div><h1>想法，从这里开始<span>。</span></h1><p>与你的智能体一起思考、编写与构建。<br />连接本地环境，让每一次对话延续。</p>
                <div class="suggestions"><button @click="prompt = '请分析当前项目的结构，介绍主要模块和启动方式。'"><span class="suggest-icon"><FolderOpen :size="18" /></span><strong>了解这个项目</strong><small>梳理代码结构与关键模块</small><ArrowRight :size="15" /></button><button @click="prompt = '请检查当前项目代码，找出可能的错误并提出改进建议。'"><span class="suggest-icon mint"><FileCode2 :size="18" /></span><strong>一起改进代码</strong><small>发现问题，探索更好的实现</small><ArrowRight :size="15" /></button></div>
                <div class="welcome-foot"><span class="dot live"></span> 基于本机真实环境 <span>·</span> 对话记录保存在本地</div>
              </div>
              <div v-for="(message, index) in messages" :key="index" class="message" :class="message.role"><span class="avatar" :class="message.role">{{ message.role === 'user' ? '你' : '⌘' }}</span><div class="message-body"><strong>{{ message.role === 'user' ? '你' : agent?.name || 'Codex' }}</strong><pre :class="{ 'failed-text': message.failed }">{{ message.text }}</pre></div></div>
              <div v-if="sending" class="message"><span class="avatar">⌘</span><div class="thinking"><span></span><span></span><span></span>智能体正在处理任务…</div></div>
            </div>
            <div class="composer-area">
              <div v-if="active?.cwd && active.cwd !== status.config.workdir" class="context-note">该历史会话来自 {{ active.cwd }}，继续对话将使用当前配置的工作目录。</div>
              <div v-if="!agent?.chat && !loading" class="context-note">{{ agent?.name }} 当前支持查看历史，直接对话适配尚未接入。</div>
              <form class="composer" @submit.prevent="send"><textarea v-model="prompt" @keydown="keydown" placeholder="描述你的想法，或让智能体帮你完成一个任务…" aria-label="发送给智能体的消息" :disabled="sending || !agent?.chat || loadingHistory" rows="2"></textarea><div v-if="customModelOpen" class="custom-model-editor"><label for="custom-model-id">自定义模型 ID</label><div><input id="custom-model-id" v-model="customModel" placeholder="输入模型 ID" maxlength="128" :disabled="executionUpdating" @keydown.enter.prevent.stop="!$event.isComposing && customModel.trim() && saveModel(customModel)" /><button type="button" class="primary-button" @click="saveModel(customModel)" :disabled="!customModel.trim() || modelDisabled">应用</button><button type="button" class="icon-btn" @click="customModelOpen = false" aria-label="取消自定义模型"><X :size="15" /></button></div><small>使用当前本机配置的模型服务；模型 ID 需由该服务支持。</small></div><div class="composer-controls"><div class="composer-options"><select v-model="selectedAgent" :disabled="!!active || sending" aria-label="选择智能体"><option v-for="a in agents" :key="a.id" :value="a.id" :disabled="!a.chat">{{ a.name }}{{ a.chat ? '' : ' · 未接入' }}</option></select><label class="model-control" :title="'本机模型列表，仅供参考；实际可用性取决于当前服务与认证'"><Cpu :size="13" /><select :value="customModelOpen ? '__custom__' : status.config.model || ''" @change="changeModel" :disabled="modelDisabled" aria-label="选择模型"><option value="">{{ modelCatalog.defaultModel ? '本机默认 · ' + modelCatalog.defaultModel : '沿用本机配置' }}</option><option v-for="model in modelOptions" :key="model.id" :value="model.id">{{ model.name }} · {{ model.source }}</option><option value="__custom__">自定义模型 ID…</option></select></label><span class="composer-divider"></span><label class="permission" :title="permissionHint"><ShieldCheck :size="13" /><select :value="status.config.sandbox || 'read-only'" @change="changePermission" :disabled="permissionDisabled" aria-label="执行权限"><option value="read-only">只读模式</option><option value="workspace-write">读写工作目录</option></select></label></div><button type="submit" class="send-button" aria-label="发送消息" :disabled="!prompt.trim() || sending || !agent?.chat || loadingHistory || executionUpdating || workspaceBusy"><ArrowUp :size="18" /></button></div></form>
              <div class="composer-caption"><span>Enter 发送 <span class="caption-dot">·</span> Shift + Enter 换行</span><span><Terminal :size="11" /> 在你的机器上运行</span></div>
            </div>
          </template>

          <div v-else-if="page === 'workspaces'" ref="workspacesPage" class="settings-page workspaces-page">
            <div class="page-eyebrow">YOUR PROJECTS, YOUR WORKSPACES</div><div class="page-title-row"><h1>每个项目，都有自己的空间。</h1><button class="primary-button" :disabled="workspaceDisabled" @click="editWorkspace()"><Plus :size="15" /> 添加工作空间</button></div><p class="page-description">按项目管理目录、模型、权限与本地会话。当前工作空间：{{ workdirName }}。</p>
            <form v-if="workspaceEditor" class="workspace-editor" @submit.prevent="saveWorkspace"><div class="section-heading"><h2>{{ workspaceEditor === 'new' ? '添加工作空间' : '编辑工作空间' }}</h2><button type="button" class="icon-btn" aria-label="关闭编辑" @click="workspaceEditor = null"><X :size="16" /></button></div><div class="form-grid"><label>空间名称<input v-model="workspaceForm.name" maxlength="60" placeholder="例如：官网项目" /></label><label>模型 ID <span class="optional">可选</span><input v-model="workspaceForm.model" placeholder="留空沿用本机配置" /></label><label class="full">本地项目目录<input v-model="workspaceForm.workdir" required placeholder="填写已存在的项目绝对路径" :readonly="workspaceEditor !== 'new'" /><small>已有空间的项目目录固定，切换项目请添加新空间。</small></label><label class="full">执行权限<select v-model="workspaceForm.sandbox"><option value="read-only">只读模式</option><option value="workspace-write">读写工作目录</option></select></label></div><div class="config-actions"><button type="submit" class="primary-button" :disabled="workspaceDisabled">{{ workspaceBusy ? '保存中…' : '保存工作空间' }}</button><button type="button" class="subtle-button" @click="workspaceEditor = null" :disabled="workspaceBusy">取消</button></div></form>
            <div class="workspace-cards"><article v-for="workspace in workspaceData.items" :key="workspace.id" class="workspace-card" :class="{ active: workspace.id === workspaceData.activeId }"><div class="workspace-card-title"><span class="workspace-icon"><FolderOpen :size="19" /></span><h2>{{ workspace.name }}</h2><span v-if="workspace.id === workspaceData.activeId" class="pill">当前空间</span></div><p class="workspace-card-path">{{ workspace.workdir }}</p><div class="workspace-card-meta"><span><MessageSquare :size="13" />{{ sessions.filter(s => s.workspaceId === workspace.id).length }} 条本地会话</span><span>{{ workspace.sandbox === 'workspace-write' ? '读写工作目录' : '只读模式' }}</span></div><div class="workspace-card-model"><Cpu :size="13" />{{ workspace.model || '沿用本机模型' }}</div><div class="config-actions"><button class="subtle-button" :disabled="workspaceDisabled" @click="switchWorkspace(workspace.id)">{{ workspace.id === workspaceData.activeId ? '进入对话' : '切换空间' }}</button><button class="icon-btn" aria-label="编辑工作空间" :disabled="workspaceDisabled" @click="editWorkspace(workspace)"><Pencil :size="15" /></button><button class="icon-btn" aria-label="移除工作空间" :disabled="workspaceDisabled || workspaceData.items.length <= 1" @click="workspaceRemoval = workspace.id"><Trash2 :size="15" /></button></div><div v-if="workspaceRemoval === workspace.id" class="workspace-remove-confirm"><p>仅移除工作空间记录，保留项目文件和原始会话。</p><button class="subtle-button" :disabled="workspaceDisabled" @click="removeWorkspace(workspace.id)">确认移除</button><button class="icon-btn" @click="workspaceRemoval = null">取消</button></div></article></div>
            <section v-if="unassignedSessions.length" class="unassigned-section"><div class="section-heading"><h2>其他本地会话</h2><span class="muted text-xs">添加对应目录后自动归类</span></div><div v-for="directory in [...new Set(unassignedSessions.map(s => s.cwd).filter(Boolean))]" :key="directory" class="import-workspace"><FolderOpen :size="15" /><span :title="directory">{{ directory }}</span><button class="subtle-button" :disabled="workspaceDisabled" @click="editWorkspace(undefined, directory)">添加为空间</button></div></section>
          </div>
          <div v-else-if="page === 'agents'" class="settings-page"><div class="page-eyebrow">CONNECTED TO YOUR MACHINE</div><h1>你的智能体，各就各位。</h1><p class="page-description">自动检测服务端本机 CLI 与会话目录，每 15 秒同步环境状态。</p><div class="section-heading"><h2>本地环境 <span>{{ agents.length }}</span></h2><button class="subtle-button" @click="detect" :disabled="detecting"><RefreshCw :size="14" />{{ detecting ? '检测中…' : '重新检测' }}</button></div><p v-if="agentsError" role="alert">{{ agentsError }}</p><p class="muted text-xs" role="status">{{ agentsCheckedAt ? '最近检测：' + time(agentsCheckedAt) : detecting ? '正在检测本机环境…' : '等待环境检测' }}</p><div class="agent-grid"><article v-for="a in agents" :key="a.id" class="agent-card"><div class="agent-card-top"><span class="provider-symbol" :class="a.id">{{ a.name.slice(0, 1) }}</span><span class="status-badge" :class="{ available: a.installed }"><span class="dot" :class="{ live: a.installed }"></span>{{ a.installed ? '检测到 CLI' : '未检测到 CLI' }}</span></div><h3>{{ a.name }}</h3><p>{{ a.vendor }}</p><code v-if="a.cliPath" class="agent-cli-path" :title="a.cliPath">{{ a.cliPath }}</code><p v-else class="agent-cli-path">未在服务端常见安装位置找到 CLI</p><div class="capabilities"><span :class="{ enabled: a.chat }"><Check v-if="a.chat" :size="12" /><Circle v-else :size="10" />{{ a.chat ? '支持本地对话' : '对话适配待接入' }}</span><span :class="{ enabled: a.history && a.historySupported }"><Check v-if="a.history && a.historySupported" :size="12" /><Circle v-else :size="10" />{{ a.historySupported ? a.history ? '可读取本地历史' : '未找到历史目录' : '历史适配待接入' }}</span></div></article></div><div class="info-box"><ShieldCheck :size="18" /><p>环境检测只检查可执行文件与本地目录，不代表模型已登录。DeepSeek 也可作为其他 CLI 的模型服务使用，具体能力取决于对应客户端配置。</p></div></div>

          <div v-else class="settings-page robot-page"><div class="page-eyebrow">DINGTALK INTEGRATION</div><div class="page-title-row"><h1>把智能体，带到钉钉。</h1><span class="status-badge" :class="{ available: status.robotStatus === 'running' }"><span class="dot" :class="{ live: status.robotStatus === 'running' }"></span>{{ status.robotExternal ? '其他实例运行中' : robotLabels[status.robotStatus] }}</span></div><p class="page-description">独立管理 Stream 机器人，将钉钉消息交给本机 Codex。</p><div v-if="robotConflict" class="robot-conflict" role="alert"><strong>检测到已有机器人实例{{ robotConflict.pid ? ' · PID ' + robotConflict.pid : '' }}</strong><p>强制启动会停止旧机器人进程，清理锁文件后重新启动。未完成的任务可能被中断。</p><div class="config-actions"><button class="primary-button" type="button" :disabled="robotOperating" @click="robotAction('start', true)">{{ robotOperating ? '正在停止旧进程…' : '强制启动' }}</button><button type="button" class="subtle-button" :disabled="robotOperating" @click="robotConflict = null">取消</button></div></div><form @submit.prevent="saveConfig"><section class="config-section"><div class="section-heading"><h2><Bot :size="17" /> 机器人连接</h2><span class="muted text-xs">Stream 模式</span></div><div class="form-grid"><label>Client ID<input v-model="form.clientId" placeholder="钉钉应用的 Client ID / AppKey" autocomplete="off" /></label><label>Client Secret<input v-model="form.clientSecret" type="password" :placeholder="status.config.secretConfigured ? '已配置 · 留空保留原密钥' : '输入 Client Secret / AppSecret'" autocomplete="new-password" /></label><label class="full">允许使用的用户<input v-model="form.allowedUsers" placeholder="senderStaffId，多个以英文逗号分隔" /><small>仅白名单用户可执行任务，留空时无法启动机器人。</small></label><label class="full">允许的会话 <span class="optional">可选</span><input v-model="form.allowedConversations" placeholder="conversationId，留空允许白名单用户的所有会话" /></label></div></section><section class="config-section"><div class="section-heading"><h2><FolderOpen :size="17" /> 当前工作空间执行环境</h2></div><div class="form-grid"><label class="full">工作目录<input v-model="form.workdir" readonly placeholder="请在工作空间管理中添加或切换项目" /></label><label>执行权限<select v-model="form.sandbox"><option value="read-only">只读 · 分析与问答</option><option value="workspace-write">允许修改工作目录</option></select></label><label>Codex 模型 <span class="optional">可选</span><input v-model="form.model" placeholder="留空沿用本机配置" /></label></div></section><div class="config-actions"><button class="primary-button" type="submit" :disabled="status.robotStatus !== 'stopped' || status.busy || executionUpdating"><Check :size="15" /> 保存配置</button><button v-if="status.robotStatus === 'stopped'" class="subtle-button" type="button" @click="robotAction('start')" :disabled="status.busy || robotOperating || status.robotActionPending"><Radio :size="15" /> 启动机器人</button><button v-else class="subtle-button" type="button" @click="robotAction('stop')" :disabled="status.robotStatus === 'stopping' || robotOperating"><Square :size="13" /> 停止机器人</button></div></form><div class="info-box"><ShieldCheck :size="18" /><p>配置保存在本机 .data/studio.json，密钥不会回显。机器人使用当前工作空间的目录、模型和权限。修改或切换前请停止机器人，运行日志在右侧实时更新。</p></div></div>
        </main>

        <aside v-if="panel && page !== 'workspaces'" class="inspector"><div class="inspector-tabs"><button :class="{ active: tab === 'changes' }" @click="tab = 'changes'"><FileCode2 :size="14" /> 代码变更 <span v-if="files.length">{{ files.length }}</span></button><button :class="{ active: tab === 'logs' }" @click="tab = 'logs'"><Terminal :size="14" /> 运行日志 <span class="dot live" v-if="status.robotStatus === 'running'"></span></button></div><template v-if="tab === 'changes'"><div class="inspector-subhead"><span><GitBranch :size="13" /> 工作区变更</span><div class="diff-toolbar"><button class="icon-btn" @click="refreshDiff().catch(e => error = e.message)" aria-label="刷新代码变更"><RefreshCw :size="13" /></button><button class="subtle-button" @click="openDiffPreview" aria-label="放大预览代码变更" title="放大预览"><Maximize2 :size="14" /> 放大预览</button></div></div><DiffPreview :diff="diff" /><div class="inspector-note"><ShieldCheck :size="13" /><span>预览本地 Git 变更 · 包含暂存区</span></div></template><template v-else><div class="inspector-subhead"><span><span class="dot" :class="{ live: status.robotStatus === 'running' }"></span>钉钉 · {{ status.robotExternal ? '其他实例运行中' : robotLabels[status.robotStatus] }}</span><span>{{ status.logs.length }} 条</span></div><div class="log-list"><article v-for="log in status.logs" :key="log.id" class="log-entry" :class="log.level"><div><time>{{ time(log.time) }}</time><span>{{ log.source }}</span><b>{{ log.level === 'error' ? 'ERROR' : 'INFO' }}</b></div><p>{{ log.message }}</p></article></div><div class="inspector-note"><Radio :size="13" /><span>自动刷新 · 最近 400 条运行日志</span></div></template><div class="inspector-bottom"><span class="dot live"></span> LOCAL WORKSPACE <span>v0.2</span></div></aside>
      </div>
      <footer class="statusbar"><div><span class="dot" :class="{ live: online }"></span>{{ online ? '本地服务已连接' : '本地服务未连接' }}<span class="statusbar-divider"></span><FolderOpen :size="12" /><span class="path-label" :title="status.config.workdir">{{ status.config.workdir || '连接中…' }}</span></div><span><span class="dot" :class="{ live: status.robotStatus === 'running' }"></span>钉钉机器人 {{ status.robotExternal ? '其他实例运行中' : robotLabels[status.robotStatus] }}</span></footer>
    </div>
    <dialog ref="diffDialog" class="diff-dialog" aria-labelledby="diff-dialog-title" aria-describedby="diff-dialog-description" @click="event => { if (event.target === diffDialog) diffDialog.close(); }">
      <section class="diff-dialog-content">
        <header class="diff-dialog-header">
          <div class="diff-dialog-heading"><h2 id="diff-dialog-title"><FileCode2 :size="18" /> 代码变更预览 <span class="pill">{{ files.length }} 个文件</span></h2><p id="diff-dialog-description" :title="status.config.workdir">{{ status.config.workdir || '当前工作空间' }} · 包含暂存与未暂存变更</p></div>
          <div class="diff-toolbar"><button class="subtle-button" @click="refreshDiff().catch(e => error = e.message)"><RefreshCw :size="14" /> 刷新</button><button autofocus class="icon-btn" @click="diffDialog.close()" aria-label="关闭代码变更预览" title="关闭（Esc）"><X :size="20" /></button></div>
        </header>
        <DiffPreview :diff="diff" />
        <footer class="diff-dialog-footer"><span>只读预览 · 不会修改项目文件</span><span>按 Esc 关闭</span></footer>
      </section>
    </dialog>
  </div>
</template>
