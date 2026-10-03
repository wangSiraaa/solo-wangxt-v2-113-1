<script lang="ts">
  import { onMount } from 'svelte';
  import CanvasEditor from './components/CanvasEditor.svelte';
  import GroupPanel from './components/GroupPanel.svelte';
  import Inspector from './components/Inspector.svelte';
  import SeamCheck from './components/SeamCheck.svelte';
  import TimelinePanel from './components/TimelinePanel.svelte';
  import { editor, redo, selectObject, setTool, undo, updateProject, renderOptions } from './lib/stores';
  import {
    clearWorkspaceError,
    initWorkspace,
    openProject,
    removeProject,
    saveNow,
    startNewProject,
    workspace
  } from './lib/workspace';
  import { listProjects } from './lib/db';
  import { defaultProject, glideSample, p6mSample, rotationSample } from './lib/samples';
  import type { ProjectMeta, Tool } from './types';

  let savedProjects: ProjectMeta[] = [];
  let activeTab: 'group' | 'inspector' | 'seam' | 'timeline' | 'projects' = 'group';

  const tools: Array<{ id: Tool; label: string; title: string }> = [
    { id: 'select', label: '选择/拖动', title: '选择实例并拖动；拖动映射回原始路径' },
    { id: 'node', label: '节点', title: '编辑原始路径的贝塞尔节点和控制点' },
    { id: 'pen', label: '画笔', title: '拖拽或按下移动后松开，创建多边形路径' },
    { id: 'rectangle', label: '矩形', title: '创建矩形' },
    { id: 'ellipse', label: '椭圆', title: '创建椭圆贝塞尔路径' }
  ];

  async function refreshProjects() {
    savedProjects = await listProjects();
  }

  async function openSaved(meta: ProjectMeta) {
    await openProject(meta.id);
    await refreshProjects();
  }

  async function removeSaved(meta: ProjectMeta) {
    await removeProject(meta.id);
    await refreshProjects();
  }

  async function startFresh(project: Parameters<typeof startNewProject>[0]) {
    await startNewProject(project);
    await refreshProjects();
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
      void saveNow().then(refreshProjects);
    }
  }

  onMount(() => {
    void (async () => {
      await initWorkspace();
      await refreshProjects();
    })();
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  });
</script>

<main>
  <header>
    <div>
      <h1>墙纸群无缝图案编辑器</h1>
      <p>矩阵复合生成平移、旋转、反射与滑移；IndexedDB 本地保存修订与分支，无服务端。</p>
    </div>
    <div class="project-meta">
      <input
        value={$editor.project.name}
        on:change={(e) =>
          updateProject((project) => ({ ...project, name: e.currentTarget.value }))}
      />
      <span class="branch" title="当前工作副本所在分支">分支 {$workspace.branch}</span>
      <span class:ok={$editor.saved}>{$editor.saved ? '已保存' : '待保存'}</span>
      <button on:click={() => void saveNow().then(refreshProjects)}>保存</button>
    </div>
  </header>

  {#if $workspace.error}
    <div class="error-banner">
      <span>{$workspace.error}</span>
      <button on:click={clearWorkspaceError}>知道了</button>
    </div>
  {/if}

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
      <button on:click={() => startFresh(glideSample())}>滑移样例</button>
      <button on:click={() => startFresh(rotationSample())}>旋转样例</button>
      <button on:click={() => startFresh(p6mSample())}>完整样例</button>
      <button on:click={() => startFresh(defaultProject())}>重置</button>
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
        <button class:active={activeTab === 'timeline'} on:click={() => (activeTab = 'timeline')}>修订/分支</button>
        <button class:active={activeTab === 'projects'} on:click={() => (activeTab = 'projects')}>工程库</button>
      </nav>
      <div class="panel-scroll">
        {#if activeTab === 'group'}
          <GroupPanel />
        {:else if activeTab === 'inspector'}
          <Inspector />
        {:else if activeTab === 'seam'}
          <SeamCheck />
        {:else if activeTab === 'timeline'}
          <TimelinePanel />
        {:else}
          <section class="projects">
            <h3>IndexedDB 工程</h3>
            <button on:click={refreshProjects}>刷新</button>
            {#if savedProjects.length === 0}
              <p>暂无已保存工程。编辑会自动保存。</p>
            {:else}
              <ul>
                {#each savedProjects as project (project.id)}
                  <li class:current={project.id === $workspace.projectId}>
                    <div>
                      <strong>{project.name}</strong>
                      <small>{new Date(project.updatedAt).toLocaleString()}</small>
                    </div>
                    <button on:click={() => openSaved(project)}>打开</button>
                    <button class="danger" on:click={() => removeSaved(project)}>删除</button>
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
    grid-template-rows: auto auto auto 1fr;
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
  .branch {
    padding: 2px 10px;
    border-radius: 999px;
    background: #1e293b;
    color: #bfdbfe;
    font-size: 12px;
    white-space: nowrap;
  }
  .ok {
    color: #86efac;
  }
  .error-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 16px;
    background: #fef2f2;
    color: #991b1b;
    border-bottom: 1px solid #fecaca;
    font-size: 13px;
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
  .projects li.current {
    border-color: #1d4ed8;
    background: #eff6ff;
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
