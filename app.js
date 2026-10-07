const STORAGE_KEY = "sun-track-state-v1";
const cloudConfig = window.SUN_TRACK_CONFIG || {};
const cloudConfigured = Boolean(
  cloudConfig.supabaseUrl && cloudConfig.supabasePublishableKey,
);
const cloudClient = cloudConfigured && window.supabase
  ? window.supabase.createClient(
      cloudConfig.supabaseUrl,
      cloudConfig.supabasePublishableKey,
    )
  : null;
const cloudEnabled = Boolean(cloudClient);

let cloudSession = null;
let cloudReady = false;
let cloudLoading = cloudConfigured;
let cloudSyncTimer = null;
let cloudSyncStatus = cloudConfigured ? "loading" : "local";
let lastSyncedPayload = "";
let authMode = "login";
let passwordRecoveryMode = false;
const hadLegacyLocalStateAtBoot = Boolean(localStorage.getItem(STORAGE_KEY));

const palette = ["#E4EBF1", "#E8EFE8", "#F1E7D3", "#EBE5EF", "#EAE7DF"];

const initialState = {
  users: [{ id: "local-user", name: "本地用户", color: "#7b98b4" }],
  currentUserId: "local-user",
  identityConfirmed: false,
  identityGateSource: null,
  userMenuOpen: false,
  notificationPreferences: {},
  view: "dashboard",
  activeProjectId: null,
  activeNodeId: null,
  activeNoteId: null,
  projectQuery: "",
  projectFilter: "all",
  projectScope: "all",
  modal: null,
  editing: null,
  inlineEdit: null,
  confirmation: null,
  contextMenu: null,
  highlightTaskId: null,
  projects: [],
};

let state = loadState();

function normalizeState(rawState) {
  const loaded = {
    ...structuredClone(initialState),
    ...(rawState || {}),
    modal: null,
    editing: null,
    inlineEdit: null,
    confirmation: null,
    contextMenu: null,
    highlightTaskId: null,
    projectQuery: "",
    globalQuery: "",
    identityConfirmed: false,
    identityGateSource: null,
    userMenuOpen: false,
  };
  loaded.users = loaded.users?.length
    ? loaded.users
    : structuredClone(initialState.users);
  loaded.projects ||= [];
  loaded.notificationPreferences ||= {};
  loaded.currentUserId = loaded.currentUserId || loaded.users[0].id;
  for (const project of loaded.projects) {
    project.scope ||= "private";
    project.shares ||= [];
    project.members ||= [];
    project.reviewers ||= [];
    project.nodes ||= [];
    project.publicFiles ||= [];
    for (const node of project.nodes) {
      node.notes ||= [];
      node.tasks ||= [];
      node.files ||= [];
    }
  }
  return loaded;
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return structuredClone(initialState);
  try {
    return normalizeState(JSON.parse(saved));
  } catch {
    return structuredClone(initialState);
  }
}

function persistentState() {
  return {
    ...state,
    modal: null,
    editing: null,
    inlineEdit: null,
    confirmation: null,
    contextMenu: null,
    highlightTaskId: null,
    projectQuery: "",
    globalQuery: "",
    identityConfirmed: false,
    identityGateSource: null,
    userMenuOpen: false,
  };
}

function activeStorageKey() {
  return cloudSession?.user?.id
    ? `${STORAGE_KEY}:${cloudSession.user.id}`
    : STORAGE_KEY;
}

function saveState() {
  const persistent = persistentState();
  const payload = JSON.stringify(persistent);
  localStorage.setItem(activeStorageKey(), payload);
  if (cloudReady && cloudSession && payload !== lastSyncedPayload) {
    cloudSyncStatus = "saving";
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = window.setTimeout(syncCloudState, 650);
  }
}

function cloudUserProfile(user) {
  const name =
    user.user_metadata?.display_name ||
    user.email?.split("@")[0] ||
    "我";
  return { id: user.id, name, color: "#7b98b4", email: user.email || "" };
}

function attachCloudUser(user) {
  const profile = cloudUserProfile(user);
  const previous = state.users.find((item) => item.name === profile.name);
  if (previous && previous.id !== profile.id) {
    for (const project of state.projects) {
      for (const share of project.shares || [])
        if (share.userId === previous.id) share.userId = profile.id;
    }
  }
  state.users = [
    profile,
    ...state.users.filter(
      (item) => item.id !== profile.id && item.name !== profile.name,
    ),
  ];
  state.currentUserId = profile.id;
  state.identityConfirmed = true;
  return profile;
}

function migrateLegacyIdentity(user) {
  const profile = cloudUserProfile(user);
  if (state.cloudIdentityMigrationVersion === 1) {
    attachCloudUser(user);
    return false;
  }

  const legacyUser = state.users.find(
    (item) =>
      item.id !== profile.id &&
      state.projects.some((project) => project.owner === item.name),
  );
  const legacyName = legacyUser?.name;
  if (legacyUser && legacyName) {
    for (const project of state.projects) {
      if (project.owner === legacyName) project.owner = profile.name;
      project.members = (project.members || []).map((name) =>
        name === legacyName ? profile.name : name,
      );
      project.reviewers = (project.reviewers || []).map((name) =>
        name === legacyName ? profile.name : name,
      );
      for (const share of project.shares || [])
        if (share.userId === legacyUser.id) share.userId = profile.id;
      for (const node of project.nodes || []) {
        for (const note of node.notes || [])
          if (note.author === legacyName) note.author = profile.name;
        for (const task of node.tasks || [])
          if (task.assignee === legacyName) task.assignee = profile.name;
      }
    }
    state.users = state.users.filter((item) => item.id !== legacyUser.id);
  }
  state.cloudIdentityMigrationVersion = 1;
  attachCloudUser(user);
  return Boolean(legacyUser);
}

function emptyStateForUser(user) {
  const profile = cloudUserProfile(user);
  const fresh = normalizeState({
    users: [profile],
    currentUserId: profile.id,
    projects: [],
    notificationPreferences: {},
    activeProjectId: null,
    activeNodeId: null,
    view: "dashboard",
  });
  fresh.identityConfirmed = true;
  return fresh;
}

async function syncCloudState() {
  if (!cloudReady || !cloudSession) return;
  const persistent = persistentState();
  const payload = JSON.stringify(persistent);
  if (payload === lastSyncedPayload) {
    cloudSyncStatus = "saved";
    return;
  }
  const { error } = await cloudClient.from("user_states").upsert({
    user_id: cloudSession.user.id,
    state: persistent,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    cloudSyncStatus = "error";
    showToast(`云端保存失败：${error.message}`);
    renderSyncStatusOnly();
    return;
  }
  lastSyncedPayload = payload;
  cloudSyncStatus = "saved";
  renderSyncStatusOnly();
}

function renderSyncStatusOnly() {
  const label = document.querySelector("[data-cloud-sync-status]");
  if (label) label.textContent = cloudSyncText();
}

function cloudSyncText() {
  return {
    loading: "正在读取云端数据……",
    saving: "正在保存到云端……",
    saved: "已与云端同步",
    error: "云端同步失败",
    local: "本地模式",
  }[cloudSyncStatus];
}

async function loadCloudState(session) {
  cloudReady = false;
  cloudLoading = true;
  cloudSyncStatus = "loading";
  cloudSession = session;
  render();

  const { data, error } = await cloudClient
    .from("user_states")
    .select("state")
    .eq("user_id", session.user.id)
    .maybeSingle();

  if (error) {
    cloudLoading = false;
    cloudSyncStatus = "error";
    state.identityConfirmed = false;
    showToast(`云端数据读取失败：${error.message}`);
    render();
    return;
  }

  let identityMigrated = false;
  if (data?.state) {
    state = normalizeState(data.state);
    identityMigrated = migrateLegacyIdentity(session.user);
  } else if (hadLegacyLocalStateAtBoot) {
    state = normalizeState(state);
    identityMigrated = migrateLegacyIdentity(session.user);
  } else {
    state = emptyStateForUser(session.user);
  }

  cloudLoading = false;
  cloudReady = true;
  cloudSyncStatus = data?.state ? "saved" : "saving";
  lastSyncedPayload = data?.state && !identityMigrated
    ? JSON.stringify(persistentState())
    : "";
  saveState();
  render();
  if (!data?.state) {
    await syncCloudState();
    showToast(
      hadLegacyLocalStateAtBoot
        ? "已将这台电脑的原有数据迁移到云端"
        : "云端工作区已创建",
    );
  }
}

function currentUser() {
  return state.users.find((user) => user.id === state.currentUserId) || state.users[0];
}

function projectPermission(project) {
  const user = currentUser();
  if (project.owner === user.name) return "owner";
  return project.shares?.find((share) => share.userId === user.id)?.permission || null;
}

function canCurrentUserEditNodes(project) {
  return projectPermission(project) === "owner" || project.reviewers?.includes(currentUser().name);
}

function accessibleProjects() {
  return state.projects.filter((project) => projectPermission(project));
}

function notificationPreference() {
  state.notificationPreferences ||= {};
  state.notificationPreferences[state.currentUserId] ||= { read: [], dismissed: [] };
  return state.notificationPreferences[state.currentUserId];
}

function notificationRows() {
  const taskRows = allTasks()
    .filter((task) => task.status === "todo")
    .map((task) => ({ id: `task:${task.id}`, type: "task", taskId: task.id, projectId: task.projectId, nodeId: task.nodeId, title: `“${task.title}”等待处理`, detail: `${task.projectName} · 截止于 ${formatDate(task.dueDate)}` }));
  const seenNotes = new Set();
  const noteRows = accessibleProjects()
    .filter((project) => project.owner === currentUser().name || project.reviewers?.includes(currentUser().name))
    .flatMap((project) => project.nodes.flatMap((node) => node.notes.map((note) => ({ project, node, note }))))
    .filter(({ note }) => note.status === "pending" && !seenNotes.has(note.id) && seenNotes.add(note.id))
    .map(({ project, node, note }) => ({ id: `note:${note.id}`, type: "note", noteId: note.id, projectId: project.id, nodeId: node.id, title: `“${note.title}”等待审核`, detail: `${project.name} · ${node.title} · ${note.author}` }));
  const preference = notificationPreference();
  return [...taskRows, ...noteRows].filter((item) => !preference.dismissed.includes(item.id));
}

function openTaskLocation(taskId) {
  const context = findTaskContext(taskId);
  if (!context) return false;
  state.activeProjectId = context.project.id;
  state.activeNodeId = context.node.id;
  state.activeNoteId = null;
  state.highlightTaskId = context.task.id;
  state.view = "project";
  return true;
}

function openNoteLocation(projectId, nodeId, noteId, openReader = true) {
  const project = projectById(projectId);
  const node = nodeById(project, nodeId);
  if (!project || !node || !node.notes.some((note) => note.id === noteId)) return false;
  state.activeProjectId = project.id;
  state.activeNodeId = node.id;
  state.activeNoteId = openReader ? noteId : null;
  state.view = "project";
  return true;
}

function setNotificationRead(id, read = true) {
  const preference = notificationPreference();
  preference.read = preference.read.filter((item) => item !== id);
  if (read) preference.read.push(id);
}

function openNotificationSource(source) {
  setNotificationRead(source.notificationId || source.id, true);
  if ((source.notificationType || source.sourceType) === "task")
    return openTaskLocation(source.taskId);
  return openNoteLocation(source.projectId, source.nodeId, source.noteId, true);
}

function copyProjectToCurrentUser(source) {
  const copy = structuredClone(source);
  copy.id = uid("project");
  copy.name = `${source.name}（副本）`;
  copy.owner = currentUser().name;
  copy.scope = "private";
  copy.shares = [];
  copy.members = [currentUser().name];
  copy.reviewers = [];
  copy.status = "active";
  copy.updatedAt = new Date().toISOString().slice(0, 10);
  const nodeIdMap = new Map(copy.nodes.map((node) => [node.id, uid("node")]));
  for (const node of copy.nodes) {
    node.id = nodeIdMap.get(node.id);
    for (const note of node.notes) {
      note.id = uid("note");
      note.nodeIds = (note.nodeIds || []).map((id) => nodeIdMap.get(id)).filter(Boolean);
    }
    for (const task of node.tasks) task.id = uid("task");
    for (const file of node.files) file.id = uid("file");
  }
  for (const file of copy.publicFiles || []) file.id = uid("public-file");
  state.projects.push(copy);
  return copy;
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "未设置";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

function statusText(status) {
  return (
    {
      active: "进行中",
      closed: "已结题",
      draft: "草稿",
      "not-started": "未开始",
      "in-progress": "进行中",
      completed: "已完成",
      todo: "待处理",
      done: "已完成",
      cancelled: "已取消",
      pending: "待审核",
      included: "已纳入流程",
      rejected: "需修改",
      excluded: "不纳入",
    }[status] || status
  );
}

function projectById(id = state.activeProjectId) {
  return state.projects.find((project) => project.id === id);
}

function nodeById(project, id = state.activeNodeId) {
  return project?.nodes.find((node) => node.id === id);
}

function allTasks() {
  return accessibleProjects().flatMap((project) =>
    project.nodes.flatMap((node) =>
      node.tasks.map((task) => ({
        ...task,
        projectId: project.id,
        projectName: project.name,
        nodeId: node.id,
        nodeTitle: node.title,
      })),
    ),
  );
}

function render() {
  const app = document.querySelector("#app");
  if (
    cloudEnabled &&
    (passwordRecoveryMode || cloudLoading || !cloudSession)
  ) {
    app.innerHTML = renderCloudGate();
    document.title = `${cloudLoading ? "正在同步" : "登录"}｜小太阳工作轨迹`;
    return;
  }
  if (!state.identityConfirmed) {
    app.innerHTML = renderIdentityGate();
    document.title = "选择身份｜小太阳工作轨迹";
    saveState();
    return;
  }
  app.innerHTML = `
    <div class="app-shell">
      ${renderSidebar()}
      <main class="main"><div class="user-corner">${renderUserControl()}</div>${renderView()}</main>
    </div>
    ${renderModal()}
    ${renderConfirmation()}
    ${renderContextMenu()}
  `;
  document.title = `${viewTitle()}｜小太阳工作轨迹`;
  saveState();
  if (state.highlightTaskId) {
    const taskId = state.highlightTaskId;
    requestAnimationFrame(() => {
      const task = document.querySelector(`[data-task-target="${CSS.escape(taskId)}"]`);
      task?.scrollIntoView({ behavior: "smooth", block: "center" });
      window.setTimeout(() => task?.classList.remove("task-highlight"), 2200);
    });
    state.highlightTaskId = null;
  }
  if (state.inlineEdit) {
    requestAnimationFrame(() => {
      const input = document.querySelector("[data-inline-node-input]");
      input?.focus();
      input?.select();
    });
  }
}

function avatarMarkup(user, large = false) {
  return `<span class="user-avatar ${large ? "large" : ""}" style="--avatar:${escapeHtml(user.color || "#7b98b4")}">${escapeHtml(user.name.slice(0, 1))}</span>`;
}

function renderCloudGate() {
  if (cloudLoading)
    return `<div class="identity-gate"><section class="identity-card auth-card"><div class="identity-brand"><span class="sun-logo">☀</span><div><strong>小太阳工作轨迹</strong><small>记录每一步，让经验有迹可循</small></div></div><div class="cloud-loading"><span class="loading-sun">☀</span><h1>正在读取你的工作区</h1><p>请稍候……</p></div></section></div>`;

  if (passwordRecoveryMode)
    return `<div class="identity-gate"><section class="identity-card auth-card"><div class="identity-brand"><span class="sun-logo">☀</span><div><strong>小太阳工作轨迹</strong><small>记录每一步，让经验有迹可循</small></div></div><div class="auth-heading"><h1>设置新密码</h1><p>请输入一个至少 8 个字符的新密码。</p></div><form id="auth-password-form" class="auth-form"><div class="field"><label>新密码</label><input required minlength="8" type="password" name="password" autocomplete="new-password" /></div><button class="button primary identity-continue" type="submit">保存新密码</button></form></section></div>`;

  const isRegister = authMode === "register";
  const isReset = authMode === "reset";
  return `<div class="identity-gate">
    <section class="identity-card auth-card">
      <div class="identity-brand"><span class="sun-logo">☀</span><div><strong>小太阳工作轨迹</strong><small>记录每一步，让经验有迹可循</small></div></div>
      <div class="auth-heading"><h1>${isRegister ? "创建云端账号" : isReset ? "找回密码" : "登录你的工作区"}</h1><p>${isRegister ? "注册后，你可以在任何电脑上访问同一份内容。" : isReset ? "我们会向你的邮箱发送密码重置链接。" : "你的项目、笔记和任务将从云端加载。"}</p></div>
      <form id="auth-form" class="auth-form">
        ${isRegister ? `<div class="field"><label>姓名</label><input required maxlength="30" name="displayName" autocomplete="name" placeholder="例如：小太阳" /></div>` : ""}
        <div class="field"><label>邮箱</label><input required type="email" name="email" autocomplete="email" placeholder="name@example.com" /></div>
        ${isReset ? "" : `<div class="field"><label>密码</label><input required minlength="8" type="password" name="password" autocomplete="${isRegister ? "new-password" : "current-password"}" placeholder="至少 8 个字符" /></div>`}
        <button class="button primary identity-continue" type="submit">${isRegister ? "注册账号" : isReset ? "发送重置邮件" : "登录"}</button>
      </form>
      <div class="auth-switch">
        ${isRegister ? `<span>已有账号？</span><button data-action="set-auth-mode" data-mode="login">直接登录</button>` : isReset ? `<button data-action="set-auth-mode" data-mode="login">← 返回登录</button>` : `<button data-action="set-auth-mode" data-mode="reset">忘记密码</button><span>还没有账号？</span><button data-action="set-auth-mode" data-mode="register">免费注册</button>`}
      </div>
      <p class="identity-note">登录后内容会自动保存到你的私有云端工作区。</p>
    </section>
  </div>`;
}

function renderIdentityGate() {
  const user = currentUser();
  return `<div class="identity-gate">
    <section class="identity-card">
      ${state.identityGateSource === "workspace" ? `<button class="identity-back" data-action="return-workspace">← 返回工作区</button>` : ""}
      <div class="identity-brand"><span class="sun-logo">☀</span><div><strong>小太阳工作轨迹</strong><small>记录每一步，让经验有迹可循</small></div></div>
      <div class="identity-welcome">${avatarMarkup(user, true)}<div><h1>欢迎回来，${escapeHtml(user.name)}</h1><p>确认身份后进入你的工作区</p></div></div>
      <button class="button primary identity-continue" data-action="confirm-identity" data-user-id="${user.id}">以 ${escapeHtml(user.name)} 的身份继续</button>
      <div class="identity-divider"><span>或选择其他本地身份</span></div>
      <div class="identity-users">${state.users.map((item) => `<button data-action="confirm-identity" data-user-id="${item.id}" class="identity-user ${item.id === user.id ? "selected" : ""}">${avatarMarkup(item)}<span>${escapeHtml(item.name)}</span></button>`).join("")}</div>
      <form id="identity-form" class="identity-create"><label>创建新的本地身份</label><div><input required maxlength="20" name="name" placeholder="输入姓名" /><button class="button">创建并进入</button></div></form>
      <p class="identity-note">当前为本地模式。配置 Supabase 后将启用真实账号与跨设备同步。</p>
    </section>
  </div>`;
}

function renderUserControl() {
  const user = currentUser();
  return `<div class="user-control">
    <button class="user-trigger" data-action="toggle-user-menu">${avatarMarkup(user)}<span>${escapeHtml(user.name)}</span><span class="chevron">⌄</span></button>
    ${state.userMenuOpen ? `<div class="user-menu"><div class="user-menu-current">${avatarMarkup(user)}<div><strong>${escapeHtml(user.name)}</strong><small>${cloudEnabled ? escapeHtml(user.email || "云端账号") : "当前本地身份"}</small></div></div>${cloudEnabled ? `<div class="cloud-sync-label ${cloudSyncStatus}" data-cloud-sync-status>${cloudSyncText()}</div>` : `<button data-action="switch-identity">切换身份</button>`}<button data-action="logout">退出登录</button></div>` : ""}
  </div>`;
}

function viewTitle() {
  if (state.view === "project") return projectById()?.name || "项目";
  return {
    dashboard: "工作台",
    projects: "项目",
    tasks: "我的任务",
    review: "审核",
    notifications: "通知",
    search: "搜索",
  }[state.view];
}

function renderSidebar() {
  const items = [
    ["dashboard", "⌂", "工作台"],
    ["projects", "▦", "项目"],
    ["tasks", "✓", "我的任务"],
    ["review", "◎", "审核"],
    ["notifications", "◌", "通知"],
    ["search", "⌕", "搜索"],
  ];
  return `
    <aside class="sidebar">
      <div class="brand">
        <span class="sun-logo">☀</span>
        <div><div class="brand-name">小太阳</div><div class="brand-sub">工作轨迹</div></div>
      </div>
      <nav class="nav">
        ${items
          .map(
            ([id, icon, label]) => `
            <button class="nav-button ${state.view === id || (id === "projects" && state.view === "project") ? "active" : ""}"
              data-action="navigate" data-view="${id}">
              <span>${icon}</span><span>${label}</span>
            </button>`,
          )
          .join("")}
      </nav>
      <div class="sidebar-quote">记录每一步，<br />让经验有迹可循</div>
    </aside>`;
}

function renderView() {
  if (state.view === "projects") return renderProjects();
  if (state.view === "project") return renderProject();
  if (state.view === "tasks") return renderTasks();
  if (state.view === "review") return renderReview();
  if (state.view === "notifications") return renderNotifications();
  if (state.view === "search") return renderSearch();
  return renderDashboard();
}

function renderDashboard() {
  const tasks = allTasks().filter((task) => task.status === "todo");
  const active = accessibleProjects().filter((project) => project.status === "active");
  const pending = accessibleProjects().flatMap((project) =>
    project.nodes.flatMap((node) =>
      node.notes.filter((note) => note.status === "pending"),
    ),
  );
  return `
    <header class="page-header">
      <div><h1>你好，${escapeHtml(currentUser().name)}，今天继续推进工作吧</h1><div class="eyebrow">${formatDate(new Date().toISOString().slice(0, 10))}</div></div>
    </header>
    <div class="dashboard-grid">
      <section class="card dashboard-card wide">
        <div class="section-heading"><h2>近期任务</h2><button class="back-link" data-action="navigate" data-view="tasks">查看全部 →</button></div>
        ${
          tasks.length
            ? tasks
                .slice(0, 3)
                .map(
                  (task) => `
                  <div class="task-row dashboard-task" data-task-jump="${task.id}" title="双击前往对应项目与节点">
                    <button class="checkbox" aria-label="完成任务" data-action="toggle-task" data-task-id="${task.id}"></button>
                    <div class="task-title">${escapeHtml(task.title)}
                      <small>${escapeHtml(task.projectName)} · ${escapeHtml(task.nodeTitle)}</small>
                    </div>
                    <span class="muted">${formatDate(task.dueDate)}</span>
                  </div>`,
                )
                .join("")
            : `<div class="empty"><p>近期没有待处理任务。</p></div>`
        }
      </section>
      <section class="card dashboard-card">
        <div class="section-heading"><h2>待审核笔记</h2></div>
        <div class="metric">${pending.length}</div>
        <p class="muted">篇笔记等待处理</p>
        <button class="button small" data-action="navigate" data-view="review">去审核</button>
      </section>
      <section class="card dashboard-card">
        <div class="section-heading"><h2>项目概览</h2></div>
        <div class="metric">${active.length}</div>
        <p class="muted">个项目正在进行</p>
      </section>
    </div>
    <section style="margin-top: 30px">
      <div class="section-heading"><h2>进行中的项目</h2></div>
      <div class="project-mini-grid">
        <article class="card project-card create dashboard-create-card" data-action="open-project-modal">
          <div><div class="plus">＋</div><h3>创建新项目</h3><p class="muted">从基本信息和第一个节点开始</p></div>
        </article>
        ${active.slice(0, 2).map(renderProjectCard).join("")}
      </div>
    </section>`;
}

function renderProjects() {
  const query = state.projectQuery.trim().toLowerCase();
  const projects = accessibleProjects().filter((project) => {
    const matchesQuery =
      !query ||
      `${project.name} ${project.description} ${project.category}`
        .toLowerCase()
        .includes(query);
    const matchesFilter =
      state.projectFilter === "all" || project.status === state.projectFilter;
    const matchesScope = state.projectScope === "all" || project.scope === state.projectScope;
    return matchesQuery && matchesFilter && matchesScope;
  });
  return `
    <header class="page-header">
      <div><h1>项目</h1><div class="eyebrow">沉淀每项工作的完整办理过程</div></div>
    </header>
    <div class="toolbar">
      <input class="search-input" id="project-search" value="${escapeHtml(state.projectQuery)}" placeholder="搜索项目名称、简介或分类" />
      <select class="button" id="project-filter">
        <option value="all" ${state.projectFilter === "all" ? "selected" : ""}>全部项目</option>
        <option value="active" ${state.projectFilter === "active" ? "selected" : ""}>进行中</option>
        <option value="closed" ${state.projectFilter === "closed" ? "selected" : ""}>已结题</option>
      </select>
      <select class="button" id="project-scope">
        <option value="all" ${state.projectScope === "all" ? "selected" : ""}>全部空间</option>
        <option value="private" ${state.projectScope === "private" ? "selected" : ""}>私人项目</option>
        <option value="shared" ${state.projectScope === "shared" ? "selected" : ""}>共享项目</option>
      </select>
    </div>
    <div class="project-grid">
      <article class="card project-card create" data-action="open-project-modal">
        <div><div class="plus">＋</div><h3>创建新项目</h3><p class="muted">从基本信息和第一个节点开始</p></div>
      </article>
      ${projects.map(renderProjectCard).join("")}
    </div>`;
}

function renderProjectCard(project) {
  const completed = project.nodes.filter((node) => node.status === "completed").length;
  return `
    <article class="card project-card" data-action="open-project" data-project-id="${project.id}" data-context-type="project" data-context-id="${project.id}">
      <div class="project-mark" style="--project-color:${project.color}">${String(state.projects.indexOf(project) + 1).padStart(2, "0")}</div>
      <h3>${escapeHtml(project.name)}</h3>
      <div class="muted">${escapeHtml(project.category)}</div>
      <div class="project-meta">${completed}/${project.nodes.length} 个节点 · 更新于 ${formatDate(project.updatedAt)}</div>
      <span class="scope-label ${project.scope}">${project.scope === "shared" ? "共享" : "私人"}</span>
      <div style="position:absolute;right:18px;top:18px"><span class="badge ${project.status === "closed" ? "done" : ""}">${statusText(project.status)}</span></div>
    </article>`;
}

function renderProject() {
  const project = projectById();
  if (!project) {
    state.view = "projects";
    return renderProjects();
  }
  const node = nodeById(project);
  const permission = projectPermission(project);
  const canEdit = permission === "owner" || permission === "edit";
  const isOwner = permission === "owner";
  const canEditNode = isOwner || project.reviewers?.includes(currentUser().name);
  const completed = project.nodes.filter((item) => item.status === "completed").length;
  const progress = project.nodes.length
    ? Math.round((completed / project.nodes.length) * 100)
    : 0;
  return `
    <header class="page-header project-page-header">
      <div>
        <button class="back-link" data-action="navigate" data-view="projects">← 返回项目</button>
        <h1 style="margin-top:16px">${escapeHtml(project.name)} <span class="badge ${project.status === "closed" ? "done" : ""}">${statusText(project.status)}</span></h1>
        <div class="eyebrow">${escapeHtml(project.description)}</div>
      </div>
      <div class="inline-actions">
        ${!isOwner ? `<button class="button" data-action="copy-project">复制到我的私人项目</button>` : ""}
        ${isOwner ? `<button class="button" data-action="open-project-access">成员与权限</button>` : ""}
        ${isOwner && project.status === "closed" ? `<button class="button" data-action="reopen-project">重新开启</button>` : project.status !== "closed" ? `${canEditNode ? `<button class="button" data-action="open-node-modal">＋ 新建节点</button>` : ""}${isOwner ? `<button class="button" data-action="close-project">结题</button>` : ""}` : ""}
      </div>
    </header>
    <div class="project-layout">
      <aside class="card flow-panel">
        <div class="section-heading"><h3>办理流程</h3></div>
        ${
          project.nodes.length
            ? `<div class="flow-list">${project.nodes
                .map(
                  (item, index) => `
                  <button class="flow-node ${item.id === state.activeNodeId ? "active" : ""}" data-index="${String(index + 1).padStart(2, "0")}"
                    data-action="select-node" data-node-id="${item.id}" data-context-type="node" data-context-id="${item.id}">
                    <span data-edit-type="node" data-edit-id="${item.id}">${escapeHtml(item.title)}</span>
                    <span class="node-status ${item.status}">· ${statusText(item.status)}</span>
                  </button>`,
                )
                .join("")}</div>`
            : `<div class="empty"><div><p>还没有流程节点</p>${canEditNode && project.status !== "closed" ? `<button class="button primary" data-action="open-node-modal">创建第一个节点</button>` : ""}</div></div>`
        }
      </aside>
      <section class="card workspace-panel">
        ${state.activeNoteId ? renderNoteReader(project, node) : renderNodeWorkspace(project, node, canEdit, canEditNode)}
      </section>
      <aside class="card info-panel">
        <h3>项目概况</h3>
        <dl class="info-list">
          <div class="info-item"><dt>整体进度</dt><dd>${completed} / ${project.nodes.length} 个节点完成<div class="progress"><span style="width:${progress}%"></span></div></dd></div>
          <div class="info-item"><dt>${project.scope === "shared" ? "负责人" : "创建者"}</dt><dd>${escapeHtml(project.owner)}</dd></div>
          ${project.scope === "shared" ? `<div class="info-item"><dt><span>审核人</span>${isOwner ? `<button class="back-link compact" data-action="open-project-access">指定</button>` : ""}</dt><dd>${project.reviewers.length ? project.reviewers.map(escapeHtml).join("、") : "暂未指定"}</dd></div>` : ""}
          <div class="info-item"><dt>项目空间</dt><dd>${project.scope === "shared" ? "共享项目" : "私人项目"}</dd></div>
          <div class="info-item"><dt>项目时间</dt><dd>${formatDate(project.startDate)}<br />至 ${formatDate(project.endDate)}</dd></div>
          <div class="info-item public-files-summary">
            <dt><span>公共资料</span>${canEdit && project.status !== "closed" ? `<button class="back-link compact" data-action="open-public-files">管理</button>` : ""}</dt>
            <dd>${project.publicFiles?.length ? project.publicFiles.map((file) => `<a class="public-file-link" href="${escapeHtml(file.url)}" target="_blank" rel="noopener noreferrer">▣ ${escapeHtml(file.name)}</a>`).join("") : "暂无文件"}</dd>
          </div>
        </dl>
      </aside>
    </div>`;
}

function renderNodeWorkspace(project, node, canEdit = projectPermission(project) !== "view", canEditNode = projectPermission(project) === "owner") {
  if (!node) {
    return `<div class="empty"><div><h2>还没有流程节点</h2><p>创建节点后，可以在这里建立关联笔记、任务、文件和链接。</p>${canEditNode && project.status !== "closed" ? `<button class="button primary" data-action="open-node-modal">创建第一个节点</button>` : ""}</div></div>`;
  }
  return `
    <div class="workspace-header">
      <div class="eyebrow">${String(project.nodes.indexOf(node) + 1).padStart(2, "0")}</div>
      <div class="section-heading">
        ${
          state.inlineEdit?.nodeId === node.id && state.inlineEdit.field === "title"
            ? `<input class="inline-node-input title" data-inline-node-input data-node-id="${node.id}" data-field="title" value="${escapeHtml(node.title)}" aria-label="编辑节点标题" />`
            : `<h1 data-inline-node-field="title" data-node-id="${node.id}" title="双击原位编辑">${escapeHtml(node.title)}</h1>`
        }
        ${canEditNode && project.status !== "closed" ? `<select class="button small" data-action="change-node-status"><option value="not-started" ${node.status === "not-started" ? "selected" : ""}>未开始</option><option value="in-progress" ${node.status === "in-progress" ? "selected" : ""}>进行中</option><option value="completed" ${node.status === "completed" ? "selected" : ""}>已完成</option></select>` : ""}
      </div>
      ${
        state.inlineEdit?.nodeId === node.id && state.inlineEdit.field === "description"
          ? `<input class="inline-node-input description" data-inline-node-input data-node-id="${node.id}" data-field="description" value="${escapeHtml(node.description)}" aria-label="编辑节点说明" />`
          : `<p class="muted node-description" data-inline-node-field="description" data-node-id="${node.id}" title="双击原位编辑">${escapeHtml(node.description)}</p>`
      }
    </div>
    <div class="workspace-section">
      <div class="section-heading"><h3>工作笔记</h3>${canEdit && project.status !== "closed" ? `<button class="back-link" data-action="open-note-modal">新建笔记 ＋</button>` : ""}</div>
      ${node.notes.length ? node.notes.map(renderNoteCard).join("") : `<p class="muted">这个节点还没有工作笔记。</p>`}
    </div>
    <div class="workspace-section">
      <div class="section-heading"><h3>任务</h3>${canEdit && project.status !== "closed" ? `<button class="back-link" data-action="open-task-modal">创建任务 ＋</button>` : ""}</div>
      ${node.tasks.length ? node.tasks.map(renderNodeTask).join("") : `<p class="muted">这个节点还没有任务。</p>`}
    </div>
    <div class="workspace-section">
      <div class="section-heading"><h3>文件与链接</h3>${canEdit && project.status !== "closed" ? `<button class="back-link" data-action="open-file-modal">添加链接 ＋</button>` : ""}</div>
      ${node.files.length ? node.files.map((file) => `<div class="content-card" data-context-type="file" data-context-id="${file.id}"><span data-edit-type="file" data-edit-id="${file.id}" title="双击编辑">▣ ${escapeHtml(file.name)}</span></div>`).join("") : `<p class="muted">这个节点还没有文件或链接。</p>`}
    </div>`;
}

function renderNoteCard(note) {
  return `<article class="content-card" data-action="open-note" data-note-id="${note.id}" data-context-type="note" data-context-id="${note.id}">
    <strong data-edit-type="note" data-edit-id="${note.id}" data-stop-open-note title="双击编辑">${escapeHtml(note.title)}</strong>
    <p>${escapeHtml(note.content.slice(0, 88))}${note.content.length > 88 ? "…" : ""}</p>
    <p>${formatDate(note.date)} · ${statusText(note.status)}</p>
  </article>`;
}

function renderNodeTask(task) {
  return `<div class="content-card task-row ${state.highlightTaskId === task.id ? "task-highlight" : ""}" data-task-target="${task.id}" data-context-type="task" data-context-id="${task.id}">
    <button class="checkbox ${task.status === "done" ? "done" : ""}" data-action="toggle-task" data-task-id="${task.id}">${task.status === "done" ? "✓" : ""}</button>
    <div class="task-title" data-edit-type="task" data-edit-id="${task.id}" title="双击编辑">${escapeHtml(task.title)}<small>${formatDate(task.dueDate)} · 负责人：${escapeHtml(task.assignee)}</small></div>
  </div>`;
}

function renderNoteReader(project, node) {
  const note = project.nodes
    .flatMap((item) => item.notes)
    .find((item) => item.id === state.activeNoteId);
  if (!note) {
    state.activeNoteId = null;
    return renderNodeWorkspace(project, node);
  }
  return `<div class="editor-content">
    <button class="back-link" data-action="close-note">← 返回“${escapeHtml(node?.title || "节点")}”</button>
    <h1 style="margin-top:28px">${escapeHtml(note.title)}</h1>
    <div class="editor-meta"><span>${escapeHtml(note.author)}</span><span>·</span><span>${formatDate(note.date)}</span><span>·</span><span>${statusText(note.status)}</span></div>
    <div class="badge">${note.nodeIds.map((id) => escapeHtml(project.nodes.find((n) => n.id === id)?.title || "")).filter(Boolean).join(" · ")}</div>
    <div style="margin-top:30px">${escapeHtml(note.content).split("\n").filter(Boolean).map((line) => `<p>${line}</p>`).join("")}</div>
  </div>`;
}

function renderTasks() {
  const tasks = allTasks();
  return `<header class="page-header"><div><h1>我的任务</h1><div class="eyebrow">跨项目查看需要处理的事项</div></div></header>
    <section class="card dashboard-card">
      ${tasks.length ? tasks.map((task) => `<div class="task-row interactive-row" data-row-open-type="task" data-task-id="${task.id}" data-context-type="task-list" data-context-id="${task.id}" title="双击前往所在位置"><button class="checkbox ${task.status === "done" ? "done" : ""}" data-action="toggle-task" data-task-id="${task.id}">${task.status === "done" ? "✓" : ""}</button><button class="row-title-button task-title" data-action="open-task-location" data-task-id="${task.id}">${escapeHtml(task.title)}<small>${escapeHtml(task.projectName)} · ${escapeHtml(task.nodeTitle)} · ${escapeHtml(task.assignee)}</small></button><span class="badge ${task.status === "done" ? "done" : ""}">${statusText(task.status)}</span></div>`).join("") : `<div class="empty"><p>还没有任务。</p></div>`}
    </section>`;
}

function renderReview() {
  const notes = accessibleProjects().filter((project) => project.owner === currentUser().name || project.reviewers?.includes(currentUser().name)).flatMap((project) =>
    project.nodes.flatMap((node) =>
      node.notes.map((note) => ({ ...note, project, node })),
    ),
  );
  return `<header class="page-header"><div><h1>审核</h1><div class="eyebrow">审核笔记是否纳入正式办理流程</div></div></header>
    <section class="card dashboard-card">
      ${notes.length ? notes.map(({ project, node, ...note }) => `<div class="note-row interactive-row" data-row-open-type="note" data-project-id="${project.id}" data-node-id="${node.id}" data-note-id="${note.id}" data-context-type="review-item" data-context-id="${note.id}" title="双击查看完整笔记"><button class="row-title-button task-title" data-action="open-review-note" data-project-id="${project.id}" data-node-id="${node.id}" data-note-id="${note.id}"><strong>${escapeHtml(note.title)}</strong><small>${escapeHtml(project.name)} · ${escapeHtml(node.title)} · ${escapeHtml(note.author)}</small></button><span class="badge ${note.status === "included" ? "done" : ""}">${statusText(note.status)}</span><button class="button small" data-action="review-note" data-note-id="${note.id}" data-status="included">纳入</button><button class="button small" data-action="review-note" data-note-id="${note.id}" data-status="rejected">退回</button></div>`).join("") : `<div class="empty"><p>还没有笔记。</p></div>`}
    </section>`;
}

function renderNotifications() {
  const notifications = notificationRows();
  const preference = notificationPreference();
  return `<header class="page-header"><div><h1>通知</h1><div class="eyebrow">任务与审核的站内提醒</div></div></header>
    <section class="card dashboard-card">
      ${notifications.length ? notifications.map((item) => `<div class="note-row interactive-row notification-row ${preference.read.includes(item.id) ? "read" : "unread"}" data-row-open-type="notification" data-notification-id="${item.id}" data-notification-type="${item.type}" data-project-id="${item.projectId}" data-node-id="${item.nodeId}" data-task-id="${item.taskId || ""}" data-note-id="${item.noteId || ""}" data-context-type="notification-item" data-context-id="${item.id}" title="双击打开通知来源"><span class="unread-dot"></span><span class="badge ${item.type === "task" ? "warning" : ""}">${item.type === "task" ? "任务" : "审核"}</span><button class="row-title-button task-title" data-action="open-notification" data-notification-id="${item.id}" data-notification-type="${item.type}" data-project-id="${item.projectId}" data-node-id="${item.nodeId}" data-task-id="${item.taskId || ""}" data-note-id="${item.noteId || ""}">${escapeHtml(item.title)}<small>${escapeHtml(item.detail)}</small></button></div>`).join("") : `<div class="empty"><p>暂时没有新通知。</p></div>`}
    </section>`;
}

function renderSearch() {
  const query = state.globalQuery || "";
  const normalized = query.trim().toLowerCase();
  const results = normalized
    ? accessibleProjects().flatMap((project) => {
        const rows = [];
        if (`${project.name} ${project.description}`.toLowerCase().includes(normalized))
          rows.push({ type: "项目", title: project.name, detail: project.description, projectId: project.id });
        project.nodes.forEach((node) => {
          if (`${node.title} ${node.description}`.toLowerCase().includes(normalized))
            rows.push({ type: "节点", title: node.title, detail: project.name, projectId: project.id, nodeId: node.id });
          node.notes.forEach((note) => {
            if (`${note.title} ${note.content}`.toLowerCase().includes(normalized))
              rows.push({ type: "笔记", title: note.title, detail: `${project.name} · ${node.title}`, projectId: project.id, nodeId: node.id, noteId: note.id });
          });
        });
        return rows;
      })
    : [];
  return `<header class="page-header"><div><h1>搜索</h1><div class="eyebrow">查找项目、流程节点和工作笔记</div></div></header>
    <input id="global-search" class="search-input" autofocus value="${escapeHtml(query)}" placeholder="输入关键词搜索" />
    <section class="card dashboard-card" style="margin-top:24px">
      ${normalized ? (results.length ? results.map((result) => `<div class="note-row" data-action="open-search-result" data-project-id="${result.projectId}" data-node-id="${result.nodeId || ""}" data-note-id="${result.noteId || ""}" style="cursor:pointer"><span class="badge">${result.type}</span><div class="task-title">${escapeHtml(result.title)}<small>${escapeHtml(result.detail)}</small></div></div>`).join("") : `<div class="empty"><p>没有找到相关内容。</p></div>`) : `<div class="empty"><p>输入项目名称、节点、问题或笔记关键词开始搜索。</p></div>`}
    </section>`;
}

function renderModal() {
  if (!state.modal) return "";
  if (state.modal === "project") return projectModal();
  if (state.modal === "node") return nodeModal();
  if (state.modal === "note") return noteModal();
  if (state.modal === "task") return taskModal();
  if (state.modal === "file") return fileModal();
  if (state.modal === "public-files") return publicFilesModal();
  if (state.modal === "project-access") return projectAccessModal();
  if (state.modal === "edit") return editModal();
  return "";
}

function renderConfirmation() {
  if (!state.confirmation) return "";
  const { title, message, confirmText = "确认", tone = "danger" } = state.confirmation;
  return `<div class="modal-layer confirm-layer" data-confirm-backdrop>
    <section class="confirm-dialog" role="alertdialog" aria-modal="true">
      <div class="confirm-icon ${tone}">${tone === "danger" ? "!" : "✓"}</div>
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p class="muted">${escapeHtml(message)}</p>
      </div>
      <div class="modal-actions">
        <button class="button" data-action="cancel-confirmation">取消</button>
        <button class="button ${tone === "danger" ? "danger-button" : "primary"}" data-action="accept-confirmation">${escapeHtml(confirmText)}</button>
      </div>
    </section>
  </div>`;
}

function requestConfirmation(options) {
  state.confirmation = options;
}

function acceptConfirmation() {
  const confirmation = state.confirmation;
  state.confirmation = null;
  if (!confirmation) return;
  if (confirmation.kind === "close-project") {
    projectById().status = "closed";
    showToast("项目已结题");
  } else if (confirmation.kind === "delete-entity") {
    deleteEntity(confirmation.entityType, confirmation.entityId);
    showToast(`${confirmation.entityLabel}已删除`);
  } else if (confirmation.kind === "delete-public-file") {
    const project = projectById();
    project.publicFiles = (project.publicFiles || []).filter(
      (file) => file.id !== confirmation.fileId,
    );
    project.updatedAt = new Date().toISOString().slice(0, 10);
    showToast("公共资料已删除");
  } else if (confirmation.kind === "delete-project") {
    const index = state.projects.findIndex((project) => project.id === confirmation.projectId);
    if (index < 0) return;
    state.projects.splice(index, 1);
    if (state.activeProjectId === confirmation.projectId) {
      const nextProject = accessibleProjects()[0];
      state.activeProjectId = nextProject?.id || null;
      state.activeNodeId = nextProject?.nodes[0]?.id || null;
      state.activeNoteId = null;
      state.view = "projects";
    }
    showToast("项目已删除");
  }
}

function saveInlineNodeEdit(input) {
  const project = projectById();
  const node = nodeById(project, input.dataset.nodeId);
  const field = input.dataset.field;
  const value = input.value.trim();
  if (!node || !["title", "description"].includes(field)) return;
  if (!value) {
    showToast(field === "title" ? "节点标题不能为空" : "节点说明不能为空");
    input.focus();
    return;
  }
  node[field] = value;
  project.updatedAt = new Date().toISOString().slice(0, 10);
  state.inlineEdit = null;
  showToast(field === "title" ? "节点标题已更新" : "节点说明已更新");
  render();
}

function modalShell(title, subtitle, body, large = false) {
  return `<div class="modal-layer" data-modal-backdrop><section class="modal-frame ${large ? "large" : ""}" role="dialog" aria-modal="true">
    <div class="modal-scroll">
    <div class="modal-header"><div><h2>${title}</h2><p class="muted">${subtitle}</p></div><button class="icon-button" data-action="close-modal">×</button></div>
    ${body}
    </div>
  </section></div>`;
}

function projectModal() {
  const user = currentUser();
  return modalShell(
    "创建新项目",
    "设置基本信息后，即可开始建立办理流程。",
    `<form id="project-form">
      <div class="form-grid">
        <div class="field full"><label>项目名称</label><input required name="name" placeholder="例如：2027 年迎新工作" /></div>
        <div class="field full"><label>项目简介</label><textarea required name="description" placeholder="简单说明工作目标与范围"></textarea></div>
        <div class="field"><label>项目分类</label><select name="category"><option>活动组织</option><option>会议安排</option><option>走访沟通</option><option>材料申报</option><option>其他事务</option></select></div>
        <div class="field"><label>负责人</label><input name="owner" value="${escapeHtml(user.name)}" readonly /></div>
        <div class="field full"><label>项目空间</label><select name="scope"><option value="private">私人项目</option><option value="shared">共享项目</option></select><p class="field-hint">私人项目默认仅你可见，创建后仍可指定人员查看或编辑。</p></div>
        <div class="field"><label>开始日期</label><input required type="date" name="startDate" /></div>
        <div class="field"><label>预计结束日期</label><input required type="date" name="endDate" /></div>
        <div class="field full"><label><input type="checkbox" name="allowJoin" /> 允许其他用户申请加入</label></div>
      </div>
      <div class="modal-actions"><button type="button" class="button" data-action="close-modal">取消</button><button class="button primary">创建项目</button></div>
    </form>`,
  );
}

function projectAccessModal() {
  const project = projectById();
  const others = state.users.filter((user) => user.name !== project.owner);
  return modalShell(
    "成员与权限",
    project.scope === "private" ? "私人项目仍可单独分享给指定人员。" : "设置共享项目成员的访问权限与审核职责。",
    `<form id="project-access-form">
      <div class="field full"><label>项目空间</label><select name="scope"><option value="private" ${project.scope === "private" ? "selected" : ""}>私人项目</option><option value="shared" ${project.scope === "shared" ? "selected" : ""}>共享项目</option></select></div>
      <div class="access-list">
        ${others.length ? others.map((user) => {
          const share = project.shares?.find((item) => item.userId === user.id);
          const reviewer = project.reviewers?.includes(user.name);
          return `<div class="access-row">${avatarMarkup(user)}<div class="access-name"><strong>${escapeHtml(user.name)}</strong><small>本地身份</small></div><select name="permission-${user.id}"><option value="none" ${!share ? "selected" : ""}>不共享</option><option value="view" ${share?.permission === "view" ? "selected" : ""}>仅查看</option><option value="edit" ${share?.permission === "edit" ? "selected" : ""}>可编辑</option></select><label class="reviewer-check"><input type="checkbox" name="reviewer-${user.id}" ${reviewer ? "checked" : ""} /> 审核人</label></div>`;
        }).join("") : `<div class="empty compact-empty"><p>还没有其他本地身份，请先从头像菜单切换身份并创建新身份。</p></div>`}
      </div>
      <div class="modal-actions"><button type="button" class="button" data-action="close-modal">取消</button><button class="button primary">保存权限</button></div>
    </form>`,
    true,
  );
}

function nodeModal() {
  return modalShell(
    "创建流程节点",
    "节点会按创建顺序加入线性办理流程。",
    `<form id="node-form"><div class="form-grid"><div class="field full"><label>节点名称</label><input required name="title" placeholder="例如：组织培训" /></div><div class="field full"><label>节点说明</label><textarea required name="description" placeholder="说明这一阶段需要完成什么"></textarea></div></div><div class="modal-actions"><button type="button" class="button" data-action="close-modal">取消</button><button class="button primary">创建节点</button></div></form>`,
  );
}

function noteModal() {
  const project = projectById();
  const isOwner = project?.owner === currentUser().name;
  const requiresReview = project?.scope === "shared" && !isOwner;
  return modalShell(
    "创建工作笔记",
    requiresReview
      ? "共享项目中的成员笔记提交后，由负责人或审核人纳入流程。"
      : "这篇笔记创建后会直接纳入当前办理流程。",
    `<form id="note-form"><div class="form-grid">
      <div class="field full"><label>笔记标题</label><input required name="title" /></div>
      <div class="field full"><label>关联节点（可多选）</label><select name="nodeIds" multiple size="4">${project.nodes.map((node) => `<option value="${node.id}" ${node.id === state.activeNodeId ? "selected" : ""}>${escapeHtml(node.title)}</option>`).join("")}</select></div>
      <div class="field"><label>记录日期</label><input required type="date" name="date" value="2026-07-30" /></div>
      <div class="field"><label>浏览权限</label><select name="visibility"><option>作者与负责人</option><option>项目全体成员</option><option>指定成员</option></select></div>
      <div class="field full"><label>正文</label><textarea required name="content" style="min-height:220px" placeholder="记录实际完成的工作、遇到的问题与解决方式……"></textarea></div>
    </div><div class="modal-actions"><button type="button" class="button" data-action="close-modal">取消</button><button class="button primary">${requiresReview ? "提交审核" : "创建笔记"}</button></div></form>`,
    true,
  );
}

function taskModal() {
  return modalShell(
    "创建任务",
    "任务必须归属于当前流程节点。",
    `<form id="task-form"><div class="form-grid"><div class="field full"><label>任务名称</label><input required name="title" /></div><div class="field full"><label>任务说明</label><textarea name="description"></textarea></div><div class="field"><label>负责人</label><input required name="assignee" value="${escapeHtml(currentUser().name)}" /></div><div class="field"><label>截止日期</label><input required type="date" name="dueDate" /></div></div><div class="modal-actions"><button type="button" class="button" data-action="close-modal">取消</button><button class="button primary">创建任务</button></div></form>`,
  );
}

function fileModal() {
  return modalShell(
    "添加文件链接",
    "本地测试版先保存文件名称和链接，后续接入真实文件上传。",
    `<form id="file-form"><div class="form-grid"><div class="field full"><label>文件或资料名称</label><input required name="name" /></div><div class="field full"><label>链接</label><input required name="url" placeholder="https://..." /></div></div><div class="modal-actions"><button type="button" class="button" data-action="close-modal">取消</button><button class="button primary">添加链接</button></div></form>`,
  );
}

function publicFilesModal() {
  const project = projectById();
  const files = project.publicFiles || [];
  const editing =
    state.editing?.type === "public-file"
      ? files.find((file) => file.id === state.editing.id)
      : null;
  return modalShell(
    "管理公共资料",
    "这里的资料属于整个项目，不需要关联具体流程节点。",
    `<div class="public-file-list">
      ${
        files.length
          ? files
              .map(
                (file) => `<div class="public-file-row">
                  <a href="${escapeHtml(file.url)}" target="_blank" rel="noopener noreferrer">
                    <span class="public-file-icon">▣</span>
                    <span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.url)}</small></span>
                  </a>
                  <div class="inline-actions">
                    <button class="icon-button" data-action="edit-public-file" data-file-id="${file.id}" title="编辑">✎</button>
                    <button class="icon-button danger" data-action="delete-public-file" data-file-id="${file.id}" title="删除">×</button>
                  </div>
                </div>`,
              )
              .join("")
          : `<div class="empty compact-empty"><p>还没有公共资料，可以在下方添加。</p></div>`
      }
    </div>
    <div class="public-file-form-heading"><h3>${editing ? "编辑资料" : "添加新资料"}</h3></div>
    <form id="public-file-form"><div class="form-grid">
      <div class="field full"><label>资料名称</label><input required name="name" value="${escapeHtml(editing?.name || "")}" placeholder="例如：迎新工作分工表.xlsx" /></div>
      <div class="field full"><label>资料链接</label><input required name="url" value="${escapeHtml(editing?.url || "")}" placeholder="https://..." /></div>
    </div><div class="modal-actions">
      ${editing ? `<button type="button" class="button" data-action="cancel-public-file-edit">取消编辑</button>` : `<button type="button" class="button" data-action="close-modal">关闭</button>`}
      <button class="button primary">${editing ? "保存修改" : "添加资料"}</button>
    </div></form>`,
  );
}

function findFile(id) {
  for (const project of state.projects)
    for (const node of project.nodes) {
      const file = node.files.find((item) => item.id === id);
      if (file) return { file, node, project };
    }
  return null;
}

function findTaskContext(id) {
  for (const project of state.projects)
    for (const node of project.nodes) {
      const task = node.tasks.find((item) => item.id === id);
      if (task) return { task, node, project };
    }
  return null;
}

function editModal() {
  const editing = state.editing;
  if (!editing) return "";
  const project = projectById();
  if (editing.type === "project") {
    if (!project || project.owner !== currentUser().name) return "";
    return modalShell(
      "编辑项目信息",
      "修改项目名称、简介、分类和时间安排。",
      `<form id="edit-project-form"><div class="form-grid">
        <div class="field full"><label>项目名称</label><input required name="name" value="${escapeHtml(project.name)}" /></div>
        <div class="field full"><label>项目简介</label><textarea required name="description">${escapeHtml(project.description)}</textarea></div>
        <div class="field"><label>项目分类</label><select name="category">${["活动组织", "会议安排", "走访沟通", "材料申报", "其他事务"].map((category) => `<option ${project.category === category ? "selected" : ""}>${category}</option>`).join("")}</select></div>
        <div class="field"><label>当前空间</label><input value="${project.scope === "shared" ? "共享项目" : "私人项目"}" readonly /></div>
        <div class="field"><label>开始日期</label><input required type="date" name="startDate" value="${escapeHtml(project.startDate)}" /></div>
        <div class="field"><label>预计结束日期</label><input required type="date" name="endDate" value="${escapeHtml(project.endDate)}" /></div>
      </div><div class="modal-actions"><button type="button" class="button" data-action="close-modal">取消</button><button class="button primary">保存修改</button></div></form>`,
    );
  }
  if (editing.type === "node") {
    const node = nodeById(project, editing.id);
    if (!node) return "";
    return modalShell(
      "编辑流程节点",
      "修改节点名称、说明和当前状态。",
      `<form id="edit-node-form"><div class="form-grid">
        <div class="field full"><label>节点名称</label><input required name="title" value="${escapeHtml(node.title)}" /></div>
        <div class="field full"><label>节点说明</label><textarea required name="description">${escapeHtml(node.description)}</textarea></div>
        <div class="field full"><label>节点状态</label><select name="status"><option value="not-started" ${node.status === "not-started" ? "selected" : ""}>未开始</option><option value="in-progress" ${node.status === "in-progress" ? "selected" : ""}>进行中</option><option value="completed" ${node.status === "completed" ? "selected" : ""}>已完成</option></select></div>
      </div><div class="modal-actions"><button type="button" class="button" data-action="close-modal">取消</button><button class="button primary">保存修改</button></div></form>`,
    );
  }
  if (editing.type === "note") {
    const note = findNote(editing.id);
    if (!note) return "";
    return modalShell(
      "编辑工作笔记",
      "修改会同步到这篇笔记关联的所有节点。",
      `<form id="edit-note-form"><div class="form-grid">
        <div class="field full"><label>笔记标题</label><input required name="title" value="${escapeHtml(note.title)}" /></div>
        <div class="field"><label>记录日期</label><input required type="date" name="date" value="${escapeHtml(note.date)}" /></div>
        <div class="field"><label>浏览权限</label><select name="visibility"><option ${note.visibility === "作者与负责人" ? "selected" : ""}>作者与负责人</option><option ${note.visibility === "项目全体成员" ? "selected" : ""}>项目全体成员</option><option ${note.visibility === "指定成员" ? "selected" : ""}>指定成员</option></select></div>
        <div class="field full"><label>正文</label><textarea required name="content" style="min-height:220px">${escapeHtml(note.content)}</textarea></div>
      </div><div class="modal-actions"><button type="button" class="button" data-action="close-modal">取消</button><button class="button primary">保存修改</button></div></form>`,
      true,
    );
  }
  if (editing.type === "task") {
    const context = findTaskContext(editing.id);
    if (!context) return "";
    const { task } = context;
    return modalShell(
      "编辑任务",
      "修改任务名称、负责人、日期和处理状态。",
      `<form id="edit-task-form"><div class="form-grid">
        <div class="field full"><label>任务名称</label><input required name="title" value="${escapeHtml(task.title)}" /></div>
        <div class="field full"><label>任务说明</label><textarea name="description">${escapeHtml(task.description || "")}</textarea></div>
        <div class="field"><label>负责人</label><input required name="assignee" value="${escapeHtml(task.assignee)}" /></div>
        <div class="field"><label>截止日期</label><input required type="date" name="dueDate" value="${escapeHtml(task.dueDate)}" /></div>
        <div class="field full"><label>任务状态</label><select name="status"><option value="todo" ${task.status === "todo" ? "selected" : ""}>待处理</option><option value="done" ${task.status === "done" ? "selected" : ""}>已完成</option><option value="cancelled" ${task.status === "cancelled" ? "selected" : ""}>已取消</option></select></div>
      </div><div class="modal-actions"><button type="button" class="button" data-action="close-modal">取消</button><button class="button primary">保存修改</button></div></form>`,
    );
  }
  if (editing.type === "file") {
    const context = findFile(editing.id);
    if (!context) return "";
    const { file } = context;
    return modalShell(
      "编辑文件链接",
      "修改资料名称或目标链接。",
      `<form id="edit-file-form"><div class="form-grid">
        <div class="field full"><label>文件或资料名称</label><input required name="name" value="${escapeHtml(file.name)}" /></div>
        <div class="field full"><label>链接</label><input required name="url" value="${escapeHtml(file.url)}" /></div>
      </div><div class="modal-actions"><button type="button" class="button" data-action="close-modal">取消</button><button class="button primary">保存修改</button></div></form>`,
    );
  }
  return "";
}

function renderContextMenu() {
  const menu = state.contextMenu;
  if (!menu) return "";
  if (menu.type === "task-list") {
    const context = findTaskContext(menu.id);
    if (!context) return "";
    const canEdit = projectPermission(context.project) !== "view" && context.project.status !== "closed";
    return `<div class="context-menu aggregate-context-menu" style="left:${menu.x}px;top:${menu.y}px"><button data-action="aggregate-task-open">打开所在位置</button>${canEdit ? `<button data-action="aggregate-task-edit">编辑任务</button><button data-action="aggregate-task-toggle">${context.task.status === "done" ? "恢复为待处理" : "标记为已完成"}</button>` : ""}</div>`;
  }
  if (menu.type === "review-item") {
    const note = findNote(menu.id);
    return `<div class="context-menu aggregate-context-menu" style="left:${menu.x}px;top:${menu.y}px"><button data-action="aggregate-review-open">查看完整笔记</button><button data-action="aggregate-review-node">打开所在节点</button>${note ? `<button data-action="aggregate-review-status" data-status="included">纳入流程</button><button data-action="aggregate-review-status" data-status="rejected">退回修改</button>` : ""}</div>`;
  }
  if (menu.type === "notification-item") {
    const read = notificationPreference().read.includes(menu.id);
    return `<div class="context-menu aggregate-context-menu" style="left:${menu.x}px;top:${menu.y}px"><button data-action="aggregate-notification-open">打开通知来源</button><button data-action="aggregate-notification-read" data-read="${read ? "false" : "true"}">${read ? "标记为未读" : "标记为已读"}</button><button class="danger" data-action="aggregate-notification-dismiss">移除这条通知</button></div>`;
  }
  if (menu.type === "project") {
    const project = projectById(menu.id);
    if (!project) return "";
    const isOwner = project.owner === currentUser().name;
    return `<div class="context-menu project-context-menu" style="left:${menu.x}px;top:${menu.y}px">
      <button data-action="project-context-open">打开项目</button>
      ${isOwner ? `<button data-action="project-context-edit">编辑项目信息</button><button data-action="project-context-toggle-scope">${project.scope === "private" ? "设为共享项目" : "设为私人项目"}</button><button data-action="project-context-access">成员与权限</button><button class="danger" data-action="project-context-delete">删除项目</button>` : `<button data-action="project-context-copy">复制到我的私人项目</button>`}
    </div>`;
  }
  const isNode = menu.type === "node";
  return `<div class="context-menu" style="left:${menu.x}px;top:${menu.y}px">
    <button data-action="context-edit">编辑${isNode ? "节点" : "内容"}</button>
    ${isNode ? `<button data-action="move-node" data-direction="-1">上移节点</button><button data-action="move-node" data-direction="1">下移节点</button>` : ""}
    <button class="danger" data-action="context-delete">删除${isNode ? "节点" : "内容"}</button>
  </div>`;
}

function openEditor(type, id) {
  state.editing = { type, id };
  state.modal = "edit";
  state.contextMenu = null;
}

function deleteEntity(type, id) {
  const project = projectById();
  if (type === "node") {
    const index = project.nodes.findIndex((node) => node.id === id);
    if (index < 0) return;
    project.nodes.splice(index, 1);
    if (state.activeNodeId === id)
      state.activeNodeId = project.nodes[Math.min(index, project.nodes.length - 1)]?.id || null;
  } else if (type === "note") {
    for (const node of project.nodes)
      node.notes = node.notes.filter((note) => note.id !== id);
    if (state.activeNoteId === id) state.activeNoteId = null;
  } else if (type === "task") {
    for (const node of project.nodes)
      node.tasks = node.tasks.filter((task) => task.id !== id);
  } else if (type === "file") {
    for (const node of project.nodes)
      node.files = node.files.filter((file) => file.id !== id);
  }
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 1800);
}

function findTask(id) {
  for (const project of state.projects)
    for (const node of project.nodes) {
      const task = node.tasks.find((item) => item.id === id);
      if (task) return task;
    }
  return null;
}

function findNote(id) {
  for (const project of state.projects)
    for (const node of project.nodes) {
      const note = node.notes.find((item) => item.id === id);
      if (note) return note;
    }
  return null;
}

function updateNoteStatus(id, status) {
  let updated = false;
  for (const project of state.projects)
    for (const node of project.nodes)
      for (const note of node.notes)
        if (note.id === id) {
          note.status = status;
          updated = true;
        }
  return updated;
}

document.addEventListener("click", async (event) => {
  if (event.target.matches("[data-confirm-backdrop]")) {
    state.confirmation = null;
    render();
    return;
  }
  if (event.target.matches("[data-modal-backdrop]")) {
    state.modal = null;
    state.editing = null;
    render();
    return;
  }
  const hadContextMenu = Boolean(state.contextMenu);
  if (state.contextMenu && !event.target.closest(".context-menu"))
    state.contextMenu = null;
  const target = event.target.closest("[data-action]");
  if (!target) {
    if (hadContextMenu) render();
    return;
  }
  const action = target.dataset.action;
  if (action === "set-auth-mode") {
    authMode = target.dataset.mode || "login";
  } else if (action === "confirm-identity") {
    state.currentUserId = target.dataset.userId;
    state.identityConfirmed = true;
    state.userMenuOpen = false;
    state.identityGateSource = null;
    state.view = "dashboard";
  } else if (action === "return-workspace") {
    state.identityConfirmed = true;
    state.identityGateSource = null;
    state.userMenuOpen = false;
  } else if (action === "toggle-user-menu") {
    state.userMenuOpen = !state.userMenuOpen;
  } else if (action === "logout" && cloudEnabled) {
    cloudReady = false;
    cloudLoading = true;
    cloudSyncStatus = "loading";
    await cloudClient.auth.signOut();
    cloudSession = null;
    cloudLoading = false;
    state = emptyStateForUser({ id: "signed-out", email: "" });
    state.identityConfirmed = false;
    authMode = "login";
  } else if (action === "switch-identity" || action === "logout") {
    state.identityConfirmed = false;
    state.identityGateSource = "workspace";
    state.userMenuOpen = false;
  } else if (action === "open-project-access") {
    state.modal = "project-access";
  } else if (action === "copy-project") {
    const copy = copyProjectToCurrentUser(projectById());
    state.activeProjectId = copy.id;
    state.activeNodeId = copy.nodes[0]?.id || null;
    state.view = "project";
    showToast("已复制到你的私人项目");
  }
  else if (action === "change-node-status") return;
  if (action === "open-note" && event.target.closest("[data-stop-open-note]"))
    return;
  if (action === "navigate") {
    state.view = target.dataset.view;
    state.activeNoteId = null;
  } else if (action === "open-project-modal") state.modal = "project";
  else if (action === "close-modal") {
    state.modal = null;
    state.editing = null;
  }
  else if (action === "open-project") {
    const project = projectById(target.dataset.projectId);
    state.activeProjectId = project.id;
    state.activeNodeId = project.nodes[0]?.id || null;
    state.activeNoteId = null;
    state.view = "project";
  } else if (action === "select-node") {
    state.activeNodeId = target.dataset.nodeId;
    state.activeNoteId = null;
  } else if (action === "open-node-modal") state.modal = "node";
  else if (action === "open-note-modal") state.modal = "note";
  else if (action === "open-task-modal") state.modal = "task";
  else if (action === "open-file-modal") state.modal = "file";
  else if (action === "open-public-files") {
    projectById().publicFiles ||= [];
    state.editing = null;
    state.modal = "public-files";
  } else if (action === "edit-public-file") {
    state.editing = { type: "public-file", id: target.dataset.fileId };
    state.modal = "public-files";
  } else if (action === "cancel-public-file-edit") {
    state.editing = null;
  } else if (action === "delete-public-file") {
    requestConfirmation({
      kind: "delete-public-file",
      fileId: target.dataset.fileId,
      title: "删除公共资料",
      message: "删除后无法恢复，确定从项目公共资料中移除这一项吗？",
      confirmText: "确认删除",
      tone: "danger",
    });
  }
  else if (action === "open-note") state.activeNoteId = target.dataset.noteId;
  else if (action === "close-note") state.activeNoteId = null;
  else if (action === "toggle-task") {
    if (projectPermission(findTaskContext(target.dataset.taskId)?.project) === "view") {
      showToast("你对这个项目只有查看权限");
      render();
      return;
    }
    const task = findTask(target.dataset.taskId);
    if (task) {
      task.status = task.status === "done" ? "todo" : "done";
      showToast(task.status === "done" ? "任务已完成" : "任务已恢复");
    }
  } else if (action === "review-note") {
    const note = findNote(target.dataset.noteId);
    const reviewProject = accessibleProjects().find((project) => project.nodes.some((node) => node.notes.some((item) => item.id === target.dataset.noteId)));
    if (note && reviewProject && (reviewProject.owner === currentUser().name || reviewProject.reviewers?.includes(currentUser().name))) {
      updateNoteStatus(note.id, target.dataset.status);
      showToast(target.dataset.status === "included" ? "笔记已纳入流程" : "笔记已退回");
    }
  } else if (action === "close-project") {
    requestConfirmation({
      kind: "close-project",
      title: "确认结题",
      message: "结题后项目将进入只读状态，仍要继续吗？",
      confirmText: "确认结题",
      tone: "neutral",
    });
  } else if (action === "reopen-project") {
    projectById().status = "active";
    showToast("项目已重新开启");
  } else if (action === "open-search-result") {
    state.activeProjectId = target.dataset.projectId;
    state.activeNodeId = target.dataset.nodeId || projectById(target.dataset.projectId)?.nodes[0]?.id;
    state.activeNoteId = target.dataset.noteId || null;
    state.view = "project";
  } else if (action === "open-task-location") {
    openTaskLocation(target.dataset.taskId);
  } else if (action === "open-review-note") {
    openNoteLocation(target.dataset.projectId, target.dataset.nodeId, target.dataset.noteId, true);
  } else if (action === "open-notification") {
    openNotificationSource(target.dataset);
  } else if (action === "aggregate-task-open") {
    openTaskLocation(state.contextMenu.id);
    state.contextMenu = null;
  } else if (action === "aggregate-task-edit") {
    const context = findTaskContext(state.contextMenu.id);
    if (context) {
      state.activeProjectId = context.project.id;
      state.activeNodeId = context.node.id;
      openEditor("task", context.task.id);
    }
  } else if (action === "aggregate-task-toggle") {
    const context = findTaskContext(state.contextMenu.id);
    if (context && projectPermission(context.project) !== "view" && context.project.status !== "closed") {
      context.task.status = context.task.status === "done" ? "todo" : "done";
      showToast(context.task.status === "done" ? "任务已完成" : "任务已恢复");
    }
    state.contextMenu = null;
  } else if (action === "aggregate-review-open") {
    openNoteLocation(state.contextMenu.projectId, state.contextMenu.nodeId, state.contextMenu.id, true);
    state.contextMenu = null;
  } else if (action === "aggregate-review-node") {
    openNoteLocation(state.contextMenu.projectId, state.contextMenu.nodeId, state.contextMenu.id, false);
    state.contextMenu = null;
  } else if (action === "aggregate-review-status") {
    if (updateNoteStatus(state.contextMenu.id, target.dataset.status))
      showToast(target.dataset.status === "included" ? "笔记已纳入流程" : "笔记已退回");
    state.contextMenu = null;
  } else if (action === "aggregate-notification-open") {
    openNotificationSource({ ...state.contextMenu, notificationId: state.contextMenu.id, sourceType: state.contextMenu.notificationType });
    state.contextMenu = null;
  } else if (action === "aggregate-notification-read") {
    setNotificationRead(state.contextMenu.id, target.dataset.read === "true");
    state.contextMenu = null;
    showToast(target.dataset.read === "true" ? "已标记为已读" : "已标记为未读");
  } else if (action === "aggregate-notification-dismiss") {
    const preference = notificationPreference();
    if (!preference.dismissed.includes(state.contextMenu.id)) preference.dismissed.push(state.contextMenu.id);
    state.contextMenu = null;
    showToast("通知已移除，原事项保持不变");
  } else if (action === "project-context-open") {
    const project = projectById(state.contextMenu.id);
    state.activeProjectId = project.id;
    state.activeNodeId = project.nodes[0]?.id || null;
    state.activeNoteId = null;
    state.contextMenu = null;
    state.view = "project";
  } else if (action === "project-context-edit") {
    state.activeProjectId = state.contextMenu.id;
    openEditor("project", state.contextMenu.id);
  } else if (action === "project-context-toggle-scope") {
    const project = projectById(state.contextMenu.id);
    if (project?.owner === currentUser().name) {
      project.scope = project.scope === "private" ? "shared" : "private";
      if (project.scope === "private") {
        project.reviewers = [];
        for (const node of project.nodes)
          for (const note of node.notes)
            if (note.status === "pending") note.status = "included";
      }
      project.updatedAt = new Date().toISOString().slice(0, 10);
      showToast(project.scope === "shared" ? "已设为共享项目" : "已设为私人项目");
    }
    state.contextMenu = null;
  } else if (action === "project-context-access") {
    state.activeProjectId = state.contextMenu.id;
    state.contextMenu = null;
    state.modal = "project-access";
  } else if (action === "project-context-copy") {
    const source = projectById(state.contextMenu.id);
    const copy = copyProjectToCurrentUser(source);
    state.activeProjectId = copy.id;
    state.activeNodeId = copy.nodes[0]?.id || null;
    state.contextMenu = null;
    state.view = "project";
    showToast("已复制到你的私人项目");
  } else if (action === "project-context-delete") {
    const project = projectById(state.contextMenu.id);
    state.contextMenu = null;
    if (project?.owner === currentUser().name)
      requestConfirmation({
        kind: "delete-project",
        projectId: project.id,
        title: "删除项目",
        message: `“${project.name}”及其中的节点、笔记、任务和资料都会被永久删除，确定继续吗？`,
        confirmText: "确认删除",
        tone: "danger",
      });
  } else if (action === "context-edit") {
    openEditor(state.contextMenu.type, state.contextMenu.id);
  } else if (action === "context-delete") {
    const { type, id } = state.contextMenu;
    const label = type === "node" ? "节点" : "内容";
    state.contextMenu = null;
    requestConfirmation({
      kind: "delete-entity",
      entityType: type,
      entityId: id,
      entityLabel: label,
      title: `删除${label}`,
      message: `删除后无法恢复，确定删除这个${label}吗？`,
      confirmText: "确认删除",
      tone: "danger",
    });
  } else if (action === "cancel-confirmation") {
    state.confirmation = null;
  } else if (action === "accept-confirmation") {
    acceptConfirmation();
  } else if (action === "move-node") {
    const project = projectById();
    const index = project.nodes.findIndex(
      (node) => node.id === state.contextMenu.id,
    );
    const next = index + Number(target.dataset.direction);
    if (index >= 0 && next >= 0 && next < project.nodes.length) {
      [project.nodes[index], project.nodes[next]] = [
        project.nodes[next],
        project.nodes[index],
      ];
      showToast("节点顺序已调整");
    }
    state.contextMenu = null;
  }
  render();
});

document.addEventListener("dblclick", (event) => {
  const aggregateRow = event.target.closest("[data-row-open-type]");
  if (aggregateRow && !event.target.closest(".checkbox, [data-action='review-note']")) {
    event.preventDefault();
    if (aggregateRow.dataset.rowOpenType === "task")
      openTaskLocation(aggregateRow.dataset.taskId);
    else if (aggregateRow.dataset.rowOpenType === "note")
      openNoteLocation(aggregateRow.dataset.projectId, aggregateRow.dataset.nodeId, aggregateRow.dataset.noteId, true);
    else if (aggregateRow.dataset.rowOpenType === "notification")
      openNotificationSource(aggregateRow.dataset);
    render();
    return;
  }
  const taskJump = event.target.closest("[data-task-jump]");
  if (taskJump) {
    const context = findTaskContext(taskJump.dataset.taskJump);
    if (!context) return;
    state.activeProjectId = context.project.id;
    state.activeNodeId = context.node.id;
    state.activeNoteId = null;
    state.highlightTaskId = context.task.id;
    state.view = "project";
    render();
    return;
  }
  const inlineNodeField = event.target.closest("[data-inline-node-field]");
  if (inlineNodeField && projectById()?.status !== "closed" && canCurrentUserEditNodes(projectById())) {
    event.preventDefault();
    event.stopPropagation();
    state.inlineEdit = {
      nodeId: inlineNodeField.dataset.nodeId,
      field: inlineNodeField.dataset.inlineNodeField,
    };
    render();
    return;
  }
  const editable = event.target.closest("[data-edit-type]");
  if (!editable || projectById()?.status === "closed" || projectPermission(projectById()) === "view" || (editable.dataset.editType === "node" && !canCurrentUserEditNodes(projectById()))) return;
  event.preventDefault();
  event.stopPropagation();
  openEditor(editable.dataset.editType, editable.dataset.editId);
  render();
});

document.addEventListener("contextmenu", (event) => {
  const entity = event.target.closest("[data-context-type]");
  if (entity && ["task-list", "review-item", "notification-item"].includes(entity.dataset.contextType)) {
    event.preventDefault();
    const x = Math.min(event.clientX, window.innerWidth - 190);
    const y = Math.min(event.clientY, window.innerHeight - 190);
    state.contextMenu = {
      type: entity.dataset.contextType,
      id: entity.dataset.contextId,
      projectId: entity.dataset.projectId,
      nodeId: entity.dataset.nodeId,
      taskId: entity.dataset.taskId,
      noteId: entity.dataset.noteId,
      notificationType: entity.dataset.notificationType,
      x,
      y,
    };
    render();
    return;
  }
  if (entity?.dataset.contextType === "project") {
    const project = projectById(entity.dataset.contextId);
    if (!project || !projectPermission(project)) return;
    event.preventDefault();
    const x = Math.min(event.clientX, window.innerWidth - 190);
    const menuHeight = project.owner === currentUser().name ? 245 : 105;
    const y = Math.min(event.clientY, window.innerHeight - menuHeight);
    state.contextMenu = { type: "project", id: project.id, x, y };
    render();
    return;
  }
  if (!entity || projectById()?.status === "closed" || projectPermission(projectById()) === "view" || (entity.dataset.contextType === "node" && !canCurrentUserEditNodes(projectById()))) return;
  event.preventDefault();
  const x = Math.min(event.clientX, window.innerWidth - 176);
  const y = Math.min(event.clientY, window.innerHeight - 170);
  state.contextMenu = {
    type: entity.dataset.contextType,
    id: entity.dataset.contextId,
    x,
    y,
  };
  render();
});

document.addEventListener("keydown", (event) => {
  const inlineInput = event.target.closest("[data-inline-node-input]");
  if (inlineInput && event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    saveInlineNodeEdit(inlineInput);
    return;
  }
  if (event.key !== "Escape") return;
  if (inlineInput) {
    state.inlineEdit = null;
    render();
    return;
  }
  if (state.confirmation) {
    state.confirmation = null;
    render();
    return;
  }
  if (state.modal || state.contextMenu) {
    state.modal = null;
    state.editing = null;
    state.contextMenu = null;
    render();
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "project-filter") {
    state.projectFilter = event.target.value;
    render();
  }
  if (event.target.id === "project-scope") {
    state.projectScope = event.target.value;
    render();
  }
  if (event.target.matches('[data-action="change-node-status"]')) {
    const node = nodeById(projectById());
    node.status = event.target.value;
    showToast("节点状态已更新");
    render();
  }
});

let searchTimer = null;

function updateSearch(input) {
  const isProjectSearch = input.id === "project-search";
  if (!isProjectSearch && input.id !== "global-search") return;
  if (isProjectSearch) state.projectQuery = input.value;
  else state.globalQuery = input.value;
  render();
  const nextInput = document.querySelector(`#${input.id}`);
  nextInput?.focus();
  nextInput?.setSelectionRange(nextInput.value.length, nextInput.value.length);
}

document.addEventListener("input", (event) => {
  if (!["project-search", "global-search"].includes(event.target.id)) return;
  if (event.isComposing || event.target.dataset.composing === "true") return;
  clearTimeout(searchTimer);
  const input = event.target;
  searchTimer = setTimeout(() => updateSearch(input), 160);
});

document.addEventListener("compositionstart", (event) => {
  if (["project-search", "global-search"].includes(event.target.id))
    event.target.dataset.composing = "true";
});

document.addEventListener("compositionend", (event) => {
  if (!["project-search", "global-search"].includes(event.target.id)) return;
  event.target.dataset.composing = "false";
  clearTimeout(searchTimer);
  updateSearch(event.target);
});

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  if (event.target.id === "auth-password-form") {
    const password = String(data.get("password") || "");
    const { error } = await cloudClient.auth.updateUser({ password });
    if (error) {
      showToast(`密码更新失败：${error.message}`);
      render();
      return;
    }
    passwordRecoveryMode = false;
    showToast("新密码已保存");
    await loadCloudState(cloudSession);
    return;
  } else if (event.target.id === "auth-form") {
    const email = String(data.get("email") || "").trim();
    const password = String(data.get("password") || "");
    const displayName = String(data.get("displayName") || "").trim();
    const submitButton = event.target.querySelector("button[type='submit']");
    submitButton.disabled = true;
    submitButton.textContent = "正在处理……";

    if (authMode === "reset") {
      const { error } = await cloudClient.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}${window.location.pathname}`,
      });
      if (error) showToast(`发送失败：${error.message}`);
      else {
        showToast("密码重置邮件已发送，请检查收件箱");
        authMode = "login";
      }
      render();
      return;
    }

    const result = authMode === "register"
      ? await cloudClient.auth.signUp({
          email,
          password,
          options: { data: { display_name: displayName } },
        })
      : await cloudClient.auth.signInWithPassword({ email, password });

    if (result.error) {
      showToast(`${authMode === "register" ? "注册" : "登录"}失败：${result.error.message}`);
      render();
      return;
    }
    if (authMode === "register" && !result.data.session) {
      showToast("注册成功，请先在邮箱中完成验证");
      authMode = "login";
      render();
      return;
    }
  } else if (event.target.id === "identity-form") {
    const name = String(data.get("name") || "").trim();
    if (!name) return;
    if (state.users.some((user) => user.name === name)) {
      showToast("这个身份已经存在");
      return;
    }
    const colors = ["#7b98b4", "#879f8a", "#ae8e6b", "#9b89a7", "#a97870"];
    const user = { id: uid("user"), name, color: colors[state.users.length % colors.length] };
    state.users.push(user);
    state.currentUserId = user.id;
    state.identityConfirmed = true;
    state.identityGateSource = null;
    state.view = "dashboard";
    showToast("本地身份已创建");
  } else if (event.target.id === "project-access-form") {
    const project = projectById();
    project.scope = data.get("scope") || "private";
    project.shares = [];
    project.reviewers = [];
    for (const user of state.users.filter((item) => item.name !== project.owner)) {
      const permission = data.get(`permission-${user.id}`);
      if (permission && permission !== "none") {
        project.shares.push({ userId: user.id, permission });
        if (data.get(`reviewer-${user.id}`) === "on" && project.scope === "shared")
          project.reviewers.push(user.name);
      }
    }
    project.members = [project.owner, ...project.shares.map((share) => state.users.find((user) => user.id === share.userId)?.name).filter(Boolean)];
    project.updatedAt = new Date().toISOString().slice(0, 10);
    state.modal = null;
    showToast("成员与权限已保存");
  } else if (event.target.id === "project-form") {
    const project = {
      id: uid("project"),
      name: data.get("name"),
      description: data.get("description"),
      category: data.get("category"),
      startDate: data.get("startDate"),
      endDate: data.get("endDate"),
      owner: currentUser().name,
      reviewers: [],
      members: [currentUser().name],
      scope: data.get("scope") || "private",
      shares: [],
      allowJoin: data.get("allowJoin") === "on",
      status: "active",
      color: palette[state.projects.length % palette.length],
      nodes: [],
      publicFiles: [],
      updatedAt: new Date().toISOString().slice(0, 10),
    };
    state.projects.push(project);
    state.activeProjectId = project.id;
    state.activeNodeId = null;
    state.view = "project";
    state.modal = null;
    showToast("项目创建成功");
  } else if (event.target.id === "node-form") {
    const project = projectById();
    const node = {
      id: uid("node"),
      title: data.get("title"),
      description: data.get("description"),
      status: "not-started",
      notes: [],
      tasks: [],
      files: [],
    };
    project.nodes.push(node);
    project.updatedAt = new Date().toISOString().slice(0, 10);
    state.activeNodeId = node.id;
    state.modal = null;
    showToast("流程节点已创建");
  } else if (event.target.id === "note-form") {
    const project = projectById();
    const author = currentUser().name;
    const nodeIds = [...event.target.elements.nodeIds.selectedOptions].map(
      (option) => option.value,
    );
    const primaryNode = nodeById(project);
    const note = {
      id: uid("note"),
      title: data.get("title"),
      date: data.get("date"),
      author,
      status: project.scope === "private" || author === project.owner ? "included" : "pending",
      visibility: data.get("visibility"),
      nodeIds,
      content: data.get("content"),
    };
    for (const nodeId of nodeIds) {
      const node = nodeById(project, nodeId);
      if (node && !node.notes.some((item) => item.id === note.id))
        node.notes.push(note);
    }
    state.modal = null;
    state.activeNodeId = primaryNode.id;
    showToast(note.status === "included" ? "笔记已创建并纳入流程" : "笔记已提交审核");
  } else if (event.target.id === "task-form") {
    nodeById(projectById()).tasks.push({
      id: uid("task"),
      title: data.get("title"),
      description: data.get("description"),
      assignee: data.get("assignee"),
      dueDate: data.get("dueDate"),
      status: "todo",
    });
    state.modal = null;
    showToast("任务已创建");
  } else if (event.target.id === "file-form") {
    nodeById(projectById()).files.push({
      id: uid("file"),
      name: data.get("name"),
      url: data.get("url"),
    });
    state.modal = null;
    showToast("链接已添加");
  } else if (event.target.id === "public-file-form") {
    const project = projectById();
    project.publicFiles ||= [];
    const editing =
      state.editing?.type === "public-file"
        ? project.publicFiles.find((file) => file.id === state.editing.id)
        : null;
    if (editing) {
      editing.name = data.get("name");
      editing.url = data.get("url");
      showToast("公共资料已更新");
    } else {
      project.publicFiles.push({
        id: uid("public-file"),
        name: data.get("name"),
        url: data.get("url"),
      });
      showToast("公共资料已添加");
    }
    project.updatedAt = new Date().toISOString().slice(0, 10);
    state.editing = null;
    state.modal = "public-files";
  } else if (event.target.id === "edit-project-form") {
    const project = projectById();
    if (project?.owner === currentUser().name) {
      project.name = data.get("name");
      project.description = data.get("description");
      project.category = data.get("category");
      project.startDate = data.get("startDate");
      project.endDate = data.get("endDate");
      project.updatedAt = new Date().toISOString().slice(0, 10);
      showToast("项目信息已更新");
    }
    state.modal = null;
    state.editing = null;
  } else if (event.target.id === "edit-node-form") {
    const node = nodeById(projectById(), state.editing.id);
    node.title = data.get("title");
    node.description = data.get("description");
    node.status = data.get("status");
    state.modal = null;
    state.editing = null;
    showToast("节点修改已保存");
  } else if (event.target.id === "edit-note-form") {
    const id = state.editing.id;
    for (const project of state.projects)
      for (const node of project.nodes)
        for (const note of node.notes)
          if (note.id === id) {
            note.title = data.get("title");
            note.date = data.get("date");
            note.visibility = data.get("visibility");
            note.content = data.get("content");
          }
    state.modal = null;
    state.editing = null;
    showToast("笔记修改已保存");
  } else if (event.target.id === "edit-task-form") {
    const context = findTaskContext(state.editing.id);
    context.task.title = data.get("title");
    context.task.description = data.get("description");
    context.task.assignee = data.get("assignee");
    context.task.dueDate = data.get("dueDate");
    context.task.status = data.get("status");
    state.modal = null;
    state.editing = null;
    showToast("任务修改已保存");
  } else if (event.target.id === "edit-file-form") {
    const context = findFile(state.editing.id);
    context.file.name = data.get("name");
    context.file.url = data.get("url");
    state.modal = null;
    state.editing = null;
    showToast("文件链接修改已保存");
  }
  render();
});

async function initializeApp() {
  if (!cloudConfigured || !cloudClient) {
    cloudLoading = false;
    cloudSyncStatus = "local";
    render();
    return;
  }

  const { data, error } = await cloudClient.auth.getSession();
  if (error) {
    cloudLoading = false;
    cloudSyncStatus = "error";
    showToast(`无法检查登录状态：${error.message}`);
    render();
    return;
  }

  if (data.session) await loadCloudState(data.session);
  else {
    cloudLoading = false;
    cloudSession = null;
    render();
  }

  cloudClient.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY" && session) {
      passwordRecoveryMode = true;
      cloudSession = session;
      cloudReady = false;
      cloudLoading = false;
      render();
      return;
    }
    if (event === "SIGNED_IN" && session && session.user.id !== cloudSession?.user?.id)
      window.setTimeout(() => loadCloudState(session), 0);
    if (event === "SIGNED_OUT") {
      cloudSession = null;
      cloudReady = false;
      cloudLoading = false;
      render();
    }
  });
}

initializeApp();
