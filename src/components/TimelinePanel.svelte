<script lang="ts">
  import { editor } from '../lib/stores';
  import { clearWorkspaceError, createCheckpoint, restoreRevision, workspace } from '../lib/workspace';
  import { checkRevision, diffPayloads, isDirtyAgainst, type RevisionDiff } from '../lib/revisions';
  import type { Revision } from '../types';

  let label = '';
  let branchFilter: string | null = null;
  let compareA: string | null = null;
  let compareB: string | null = null;
  let pendingRestoreId: string | null = null;
  let restoring = false;

  interface Entry {
    id: string;
    ok: boolean;
    revision: Revision | null;
    error: string | null;
  }

  function toEntry(record: Revision, index: number): Entry {
    const result = checkRevision(record);
    if (result.ok) return { id: result.revision.id, ok: true, revision: result.revision, error: null };
    const fallback = (record as { id?: unknown })?.id;
    return {
      id: typeof fallback === 'string' ? fallback : `corrupt-${index}`,
      ok: false,
      revision: null,
      error: result.error
    };
  }

  $: entries = $workspace.revisions.map((record, index) => toEntry(record, index));
  $: valid = entries.filter((entry) => entry.ok && entry.revision).map((entry) => entry.revision as Revision);
  $: branches = [...new Set(valid.map((revision) => revision.branch))];
  $: visible = entries
    .filter((entry) => !branchFilter || entry.revision?.branch === branchFilter)
    .slice()
    .reverse();
  $: baseRevision = valid.find((revision) => revision.id === $workspace.baseRevisionId) ?? null;
  $: dirty = isDirtyAgainst($editor.project, baseRevision);
  $: revisionA = valid.find((revision) => revision.id === compareA) ?? null;
  $: revisionB = valid.find((revision) => revision.id === compareB) ?? null;
  $: diff = computeDiff(revisionA, revisionB);
  $: pendingRevision = valid.find((revision) => revision.id === pendingRestoreId) ?? null;

  function computeDiff(a: Revision | null, b: Revision | null): RevisionDiff | null {
    if (!a || !b || a.id === b.id) return null;
    return diffPayloads(a.payload, b.payload);
  }

  function shortId(id: string | null): string {
    if (!id) return '根（无父修订）';
    return `…${id.slice(-6)}`;
  }

  function fmtTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  async function submitCheckpoint() {
    await createCheckpoint(label);
    label = '';
  }

  function askRestore(id: string) {
    pendingRestoreId = id;
  }

  async function confirmRestore(withCheckpoint: boolean) {
    if (!pendingRestoreId) return;
    restoring = true;
    try {
      if (withCheckpoint) await createCheckpoint('恢复前自动检查点');
      const ok = await restoreRevision(pendingRestoreId);
      if (ok) pendingRestoreId = null;
    } finally {
      restoring = false;
    }
  }

  function optionLabel(revision: Revision): string {
    return `${revision.label} · ${revision.branch} · ${fmtTime(revision.createdAt)}`;
  }
</script>

<section class="timeline">
  <h3>修订时间线</h3>
  <p class="context">
    当前分支 <code>{$workspace.branch}</code>
    {#if baseRevision}
      · 基修订 <code>{shortId(baseRevision.id)}</code>
    {:else}
      · 尚未创建检查点
    {/if}
    {#if dirty}<span class="dirty">有未固化修改</span>{/if}
  </p>

  <div class="checkpoint">
    <input placeholder="检查点说明（可选）" bind:value={label} />
    <button class="primary" on:click={submitCheckpoint}>创建检查点</button>
  </div>
  <p class="note">
    检查点是不可变修订：创建后继续编辑会在新分支上形成后代；恢复旧检查点同样以其为父修订开启新分支，旧版本不会被篡改。
  </p>

  {#if $workspace.error}
    <div class="error">
      <span>{$workspace.error}</span>
      <button on:click={clearWorkspaceError}>知道了</button>
    </div>
  {/if}

  {#if pendingRevision}
    <div class="confirm">
      <p>
        恢复到「{pendingRevision.label}」（{pendingRevision.branch}）？当前画布将被该修订内容替换，
        并以它为父修订在新分支上继续；原修订与分支保持不变。
      </p>
      {#if dirty}
        <p class="warn">当前工作副本有未固化到检查点的修改。恢复本身可撤销，但刷新页面后未固化的修改将丢失。</p>
      {/if}
      <div class="confirm-actions">
        {#if dirty}
          <button disabled={restoring} on:click={() => confirmRestore(true)}>先创建检查点再恢复</button>
        {/if}
        <button class="primary" disabled={restoring} on:click={() => confirmRestore(false)}>直接恢复</button>
        <button disabled={restoring} on:click={() => (pendingRestoreId = null)}>取消</button>
      </div>
    </div>
  {/if}

  {#if branches.length > 0}
    <div class="branches">
      <button class:active={branchFilter === null} on:click={() => (branchFilter = null)}>全部分支</button>
      {#each branches as branch}
        <button class:active={branchFilter === branch} on:click={() => (branchFilter = branch)}>
          {branch}（{valid.filter((revision) => revision.branch === branch).length}）
        </button>
      {/each}
    </div>
  {/if}

  {#if entries.length === 0}
    <p class="empty">还没有检查点。创建第一个检查点后，这里会显示完整时间线。</p>
  {:else}
    <ul class="entries">
      {#each visible as entry (entry.id)}
        {#if entry.ok && entry.revision}
          {@const revision = entry.revision}
          <li class:current={revision.id === $workspace.baseRevisionId}>
            <div class="row">
              <strong>{revision.label}</strong>
              <span class="chip">{revision.branch}</span>
              {#if revision.id === $workspace.baseRevisionId}<span class="badge">当前基修订</span>{/if}
            </div>
            <small>
              {fmtTime(revision.createdAt)} · 父修订 {shortId(revision.parentId)} · {revision.payload.objects.length}
              对象 · {revision.payload.group} · {revision.payload.cellWidth}×{revision.payload.cellHeight}
            </small>
            <div class="actions">
              <button on:click={() => (compareA = revision.id)}>设为对比 A</button>
              <button on:click={() => (compareB = revision.id)}>设为对比 B</button>
              <button class="primary" on:click={() => askRestore(revision.id)}>恢复</button>
            </div>
          </li>
        {:else}
          <li class="corrupt">
            <strong>⚠ 损坏或不支持的修订</strong>
            <small>ID {entry.id}：{entry.error}。该修订已被隔离，不会影响当前画布与其他检查点。</small>
          </li>
        {/if}
      {/each}
    </ul>
  {/if}

  <h4>修订差异对比</h4>
  <div class="compare">
    <label>
      A（旧）
      <select bind:value={compareA}>
        <option value={null}>选择修订</option>
        {#each valid as revision}
          <option value={revision.id}>{optionLabel(revision)}</option>
        {/each}
      </select>
    </label>
    <label>
      B（新）
      <select bind:value={compareB}>
        <option value={null}>选择修订</option>
        {#each valid as revision}
          <option value={revision.id}>{optionLabel(revision)}</option>
        {/each}
      </select>
    </label>
  </div>
  {#if diff}
    {#if diff.empty}
      <p class="empty">两个修订的群、晶格与对象完全一致。</p>
    {:else}
      <ul class="diff">
        {#if diff.group}
          <li class="group">群：{diff.group.from} → {diff.group.to}</li>
        {/if}
        {#if diff.cell}
          <li class="group">
            晶格尺寸：{diff.cell.from[0]}×{diff.cell.from[1]} → {diff.cell.to[0]}×{diff.cell.to[1]}
          </li>
        {/if}
        {#each diff.objects as object (object.id)}
          <li class={object.change}>
            <strong>
              {object.change === 'added' ? '＋ 新增' : object.change === 'removed' ? '－ 删除' : '± 修改'}
              {object.name}
            </strong>
            <code>{object.id}</code>
            <ul>
              {#each object.details as detail}
                <li>{detail}</li>
              {/each}
            </ul>
          </li>
        {/each}
      </ul>
    {/if}
  {:else}
    <p class="empty">选择两个不同的修订以查看对象 / 群差异。</p>
  {/if}
</section>

<style>
  .timeline {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  h3,
  h4 {
    margin: 0;
  }
  .context,
  .note,
  .empty {
    margin: 0;
    color: #475569;
    font-size: 12px;
    line-height: 1.5;
  }
  code {
    color: #0f172a;
    background: #e2e8f0;
    border-radius: 4px;
    padding: 0 4px;
  }
  .dirty {
    margin-left: 6px;
    color: #b45309;
    font-weight: 600;
  }
  .checkpoint {
    display: flex;
    gap: 6px;
  }
  .checkpoint input {
    flex: 1;
  }
  .primary {
    background: #1d4ed8;
    border-color: #1d4ed8;
    color: white;
  }
  .error {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 8px;
    border: 1px solid #fecaca;
    border-radius: 8px;
    background: #fef2f2;
    color: #991b1b;
    font-size: 12px;
  }
  .confirm {
    display: grid;
    gap: 8px;
    padding: 10px;
    border: 1px solid #fde68a;
    border-radius: 8px;
    background: #fffbeb;
  }
  .confirm p {
    margin: 0;
    font-size: 12px;
    color: #78350f;
    line-height: 1.5;
  }
  .confirm .warn {
    color: #b45309;
    font-weight: 600;
  }
  .confirm-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .branches {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .entries {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  .entries li {
    display: grid;
    gap: 5px;
    padding: 8px;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
  }
  .entries li.current {
    border-color: #1d4ed8;
    background: #eff6ff;
  }
  .entries li.corrupt {
    border-color: #fecaca;
    background: #fef2f2;
  }
  .entries li.corrupt strong {
    color: #991b1b;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .chip {
    padding: 1px 8px;
    border-radius: 999px;
    background: #e0e7ff;
    color: #3730a3;
    font-size: 11px;
  }
  .badge {
    padding: 1px 8px;
    border-radius: 999px;
    background: #dcfce7;
    color: #166534;
    font-size: 11px;
  }
  small {
    color: #64748b;
    word-break: break-all;
  }
  .actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .compare {
    display: grid;
    gap: 8px;
  }
  .compare label {
    display: grid;
    gap: 4px;
    font-size: 12px;
  }
  .diff {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  .diff > li {
    padding: 8px;
    border-radius: 8px;
    border: 1px solid #e2e8f0;
    font-size: 12px;
  }
  .diff > li.group {
    background: #f0f9ff;
    border-color: #bae6fd;
  }
  .diff > li.added {
    background: #f0fdf4;
    border-color: #bbf7d0;
  }
  .diff > li.removed {
    background: #fef2f2;
    border-color: #fecaca;
  }
  .diff > li.modified {
    background: #fffbeb;
    border-color: #fde68a;
  }
  .diff code {
    display: block;
    margin: 3px 0;
    word-break: break-all;
  }
  .diff ul {
    margin: 4px 0 0;
    padding-left: 16px;
    color: #475569;
  }
</style>
