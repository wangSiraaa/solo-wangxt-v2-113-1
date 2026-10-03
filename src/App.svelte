<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import CanvasEditor from './components/CanvasEditor.svelte';
  import GroupPanel from './components/GroupPanel.svelte';
  import Inspector from './components/Inspector.svelte';
  import RevisionPanel from './components/RevisionPanel.svelte';
  import SeamCheck from './components/SeamCheck.svelte';
  import {
    editor,
    markSaved,
    redo,
    selectObject,
    setTool,
    undo,
    updateProject,
    renderOptions
  } from './lib/stores';
  import {
    bootFromStorage,
    openProject,
    refreshProjectList,
    removeProject,
    revisionState,
    savedProjects,
    saveWorkingCopyNow,
    shortRevisionId,
    startNewProject
  } from './lib/controller';
  import { isStaleSave, type SaveContext } from './lib/revisions';
  import { defaultProject, glideSample, p6mSample, rotationSample } from './lib/samples';
  import type { Tool } from './types';

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let activeTab: 'group' | 'inspector' | 'seam' | 'revisions' | 'projects' = 'group';

  const tools: Array<{ id: Tool; label: string; title: string }> = [
    { id: 'select', label: '选择/拖动', title: '选择实例并拖动；拖动映射回原始路径' },
    { id: 'node', label: '节点', title: '编辑原始路径的贝塞尔节点和控制点' },
    { id: 'pen', label: '画笔', title: '拖拽或按下移动后松开，创建多边形路径' },
    { id: 'rectangle', label: '矩形', title: '创建矩形' },
    { id: 'ellipse', label: '椭圆', title: '创建椭圆贝塞尔路径' }
  ];

  function currentContext(): SaveContext {
    const state = get(editor);
    return { projectId: state.project.id, generation: state.generation };
  }

  /**
   * Debounced autosave. The scheduled write carries the working-copy
   * generation captured now; after loading another project or switching
   * revisions the generation changes and the late timer is dropped instead of
   * writing stale content into the new context.
   */
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    const context = currentContext();
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flushAutosave(context);
    }, 700);
  }

  async function flushAutosave(context: SaveContext) {
    if (isStaleSave(context, currentContext())) return;
    await saveWorkingCopyNow();
    if (isStaleSave(context, currentContext())) return;
    markSaved();
  }

  /** Persist the current context immediately (before any context switch). */
  async function flushPendingSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const context = currentContext();
    await saveWorkingCopyNow();
    if (!isStaleSave(context, currentContext())) markSaved();
  }

  async function saveNow() {
    await flushPendingSave();
  }

  async function openSaved(id: string) {
    await flushPendingSave();
    await openProject(id);
  }

  async function deleteSaved(id: string) {
    await removeProject(id);
  }

  function newProject() {
    startNewProject(defaultProject());
  }

  function loadSample(sample: ReturnType<typeof defaultProject>) {
    startNewProject(sample);
  }

  function keyboard(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if ((event.ctrlKey || event.metaKey) && (key === 'y' || (key === 'z' && event.shiftKey))) {
      event.preventDefault();
      redo();
    } else if ((event.ctrlKey || event.metaKey) && key === 's') {
      event.preventDefault();
      void saveNow();
    }
  }

  const unsubscribe = editor.subscribe(scheduleSave);

  onMount(async () => {
    await refreshProjectList();
    await bootFromStorage();
    window.addEventListener('keydown', keyboard);
  });

  onDestroy(() => {
    unsubscribe();
    window.removeEventListener('keydown', keyboard);
    if (saveTimer) clearTimeout(saveTimer);
  });
</script>

<main>
  <header>
    <div>
      <h1>墙纸群无缝图案编辑器</h1>
      <p>矩阵复合生成平移、旋转、反射与滑移；IndexedDB 本地保存，无服务端。</p>
    </div>
    <div class="project-meta">
      <input
        value={$editor.project.name}
        on:change={(e) =>
          updateProject((project) => ({ ...project, name: e.currentTarget.value }))}
      />
      <span class="branch-chip" title="当前工作分支 / 基点修订">
        {$revisionState.branch} · {shortRevisionId($revisionState.baseRevisionId)}
      </span>
      <span class:ok={$editor.saved}>{$editor.saved ? '已保存' : '待保存'}</span>
      <button on:click={saveNow}>保存</button>
    </div>
  </header>

  <section class="toolbar">
    <div class="tools">
      {#each tools as tool}
        <button class:active={$editor.tool === tool.id} title={tool.title} on:click={() => setTool(tool.id)}>
          {tool.label}
        </button>
      {/each}
    </div>
    <div class="history">
      <button disabled={!$editor.canUndo} on:click={undo}>撤销</button>
      <button disabled={!$editor.canRedo} on:click={redo}>重做</button>
    </div>
    <div class="samples">
      <button on:click={() => loadSample(glideSample())}>滑移样例</button>
      <button on:click={() => loadSample(rotationSample())}>旋转样例</button>
      <button on:click={() => loadSample(p6mSample())}>完整样例</button>
      <button on:click={newProject}>重置</button>
    </div>
    <label class="toggle"><input type="checkbox" bind:checked={$renderOptions.showDomain} />基本域</label>
    <label class="toggle"><input type="checkbox" bind:checked={$renderOptions.showGrid} />晶格</label>
    <label class="toggle"><input type="checkbox" bind:checked={$renderOptions.showSymmetry} />对称元素</label>
  </section>

  <section class="workspace">
    <aside class="left">
      <nav>
        <button class:active={activeTab === 'group'} on:click={() => (activeTab = 'group')}>群/矩阵</button>
        <button class:active={activeTab === 'inspector'} on:click={() => (activeTab = 'inspector')}>对象</button>
        <button class:active={activeTab === 'seam'} on:click={() => (activeTab = 'seam')}>接缝/导出</button>
        <button class:active={activeTab === 'revisions'} on:click={() => (activeTab = 'revisions')}>修订</button>
        <button class:active={activeTab === 'projects'} on:click={() => (activeTab = 'projects')}>工程库</button>
      </nav>
      <div class="panel-scroll">
        {#if activeTab === 'group'}
          <GroupPanel />
        {:else if activeTab === 'inspector'}
          <Inspector />
        {:else if activeTab === 'seam'}
          <SeamCheck />
        {:else if activeTab === 'revisions'}
          <RevisionPanel />
        {:else}
          <section class="projects">
            <h3>IndexedDB 工程</h3>
            <button on:click={refreshProjectList}>刷新</button>
            {#if $savedProjects.length === 0}
              <p>暂无已保存工程。编辑会自动保存。</p>
            {:else}
              <ul>
                {#each $savedProjects as project (project.id)}
                  <li>
                    <div>
                      <strong>{project.name}</strong>
                      <small>
                        {project.currentBranch} · {new Date(project.updatedAt).toLocaleString()}
                      </small>
                    </div>
                    <button on:click={() => openSaved(project.id)}>打开</button>
                    <button class="danger" on:click={() => deleteSaved(project.id)}>删除</button>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/if}
      </div>
    </aside>
    <CanvasEditor />
    <aside class="right">
      <h3>原始对象</h3>
      <p class="note">点击列表直接选择唯一原始对象；画布上所有实例共享同一身份 ID。</p>
      <ul class="object-list">
        {#each $editor.project.objects as object (object.id)}
          <li class:active={object.id === $editor.selectedId}>
            <button on:click={() => selectObject(object.id, null)}>
              <i style={`background:${object.fill};opacity:${object.opacity}`}></i>
              <span>{object.name}</span>
            </button>
          </li>
        {/each}
      </ul>
    </aside>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #0f172a;
    background: #f1f5f9;
  }
  :global(button) {
    border: 1px solid #cbd5e1;
    background: white;
    color: #0f172a;
    border-radius: 7px;
    padding: 6px 9px;
    cursor: pointer;
    font-size: 12px;
  }
  :global(button:hover) {
    background: #f8fafc;
  }
  :global(button:disabled) {
    cursor: not-allowed;
    opacity: 0.45;
  }
  :global(button.active) {
    background: #1d4ed8;
    border-color: #1d4ed8;
    color: white;
  }
  :global(input),
  :global(select) {
    box-sizing: border-box;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    padding: 5px 7px;
    font: inherit;
  }
  main {
    height: 100vh;
    display: grid;
    grid-template-rows: auto auto 1fr;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 10px 16px;
    background: #0f172a;
    color: white;
  }
  h1 {
    margin: 0;
    font-size: 18px;
  }
  p {
    margin: 3px 0 0;
    font-size: 12px;
    color: #cbd5e1;
  }
  .project-meta {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .project-meta input {
    width: 220px;
  }
  .branch-chip {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 999px;
    padding: 3px 10px;
    font-size: 11px;
    color: #cbd5e1;
    white-space: nowrap;
  }
  .ok {
    color: #86efac;
  }
  .toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 12px;
    background: white;
    border-bottom: 1px solid #cbd5e1;
  }
  .tools,
  .history,
  .samples {
    display: flex;
    gap: 6px;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
  }
  .workspace {
    min-height: 0;
    display: grid;
    grid-template-columns: 320px minmax(0, 1fr) 240px;
  }
  .left,
  .right {
    min-height: 0;
    background: white;
    border-right: 1px solid #cbd5e1;
    display: flex;
    flex-direction: column;
  }
  .right {
    border-right: 0;
    border-left: 1px solid #cbd5e1;
    padding: 12px;
  }
  nav {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    border-bottom: 1px solid #e2e8f0;
  }
  nav button {
    border: 0;
    border-bottom: 2px solid transparent;
    border-radius: 0;
  }
  nav button.active {
    background: #eff6ff;
    color: #1d4ed8;
    border-bottom-color: #1d4ed8;
  }
  .panel-scroll {
    overflow: auto;
    padding: 12px;
  }
  .projects ul,
  .object-list {
    list-style: none;
    padding: 0;
    margin: 10px 0;
    display: grid;
    gap: 7px;
  }
  .projects li {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 6px;
    padding: 7px;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
  }
  .projects small {
    display: block;
    color: #64748b;
  }
  .danger {
    background: #fff1f2;
    color: #be123c;
    border-color: #fecdd3;
  }
  .object-list button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
  }
  .object-list li.active button {
    border-color: #f97316;
    background: #fff7ed;
  }
  .object-list i {
    width: 16px;
    height: 16px;
    border: 1px solid #0f172a;
    border-radius: 50%;
    display: inline-block;
  }
  .note {
    color: #64748b;
    line-height: 1.45;
  }
</style>
