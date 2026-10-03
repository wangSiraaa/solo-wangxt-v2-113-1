<script lang="ts">
  import { revisionState, createCheckpoint, restoreRevision, shortRevisionId } from '../lib/controller';
  import { branchNames, childrenOf, diffPayloads, isEmptyDiff } from '../lib/revisions';
  import type { Revision, RevisionDiff } from '../types';

  let label = '';
  let branchFilter = '全部';
  let compareA: string | null = null;
  let compareB: string | null = null;
  let checkpointing = false;
  let restoringId: string | null = null;

  $: revisions = $revisionState.revisions;
  $: branches = branchNames(revisions);
  $: visible =
    branchFilter === '全部' ? revisions : revisions.filter((revision) => revision.branch === branchFilter);
  $: diff = computeDiff(compareA, compareB, revisions);

  function computeDiff(a: string | null, b: string | null, list: Revision[]): RevisionDiff | null {
    if (!a || !b || a === b) return null;
    const from = list.find((revision) => revision.id === a);
    const to = list.find((revision) => revision.id === b);
    if (!from || !to) return null;
    return diffPayloads(from.payload, to.payload);
  }

  function revisionById(id: string | null): Revision | null {
    return revisions.find((revision) => revision.id === id) ?? null;
  }

  async function checkpoint() {
    checkpointing = true;
    try {
      await createCheckpoint(label);
      label = '';
    } finally {
      checkpointing = false;
    }
  }

  async function restore(id: string) {
    restoringId = id;
    try {
      await restoreRevision(id);
    } finally {
      restoringId = null;
    }
  }

  function pickCompare(id: string) {
    if (compareA === null || (compareA !== null && compareB !== null)) {
      compareA = id;
      compareB = null;
    } else if (compareA === id) {
      compareA = null;
    } else {
      compareB = id;
    }
  }

  const time = (stamp: number) => new Date(stamp).toLocaleString();
</script>

<section class="revisions">
  <h3>修订时间线</h3>
  <p class="note">
    当前分支 <strong>{$revisionState.branch}</strong>，基于修订
    <code>{shortRevisionId($revisionState.baseRevisionId)}</code>。 检查点不可变；继续编辑会在新分支上形成后代。
  </p>

  <div class="checkpoint">
    <input placeholder="检查点说明（可空）" bind:value={label} />
    <button disabled={checkpointing} on:click={checkpoint}>创建检查点</button>
  </div>

  {#if $revisionState.error}
    <p class="error">{$revisionState.error}</p>
  {/if}

  {#if $revisionState.corrupt.length > 0}
    <div class="corrupt">
      <strong>{$revisionState.corrupt.length} 条修订记录损坏，已跳过且未被改动：</strong>
      {#each $revisionState.corrupt as item}
        <small>{item.id}：{item.reason}</small>
      {/each}
    </div>
  {/if}

  <label class="filter">
    分支
    <select bind:value={branchFilter}>
      <option>全部</option>
      {#each branches as branch}
        <option>{branch}</option>
      {/each}
    </select>
  </label>

  {#if visible.length === 0}
    <p class="empty">还没有检查点。编辑后点击“创建检查点”留下第一个不可变修订。</p>
  {:else}
    <ul class="timeline">
      {#each visible as revision (revision.id)}
        {@const forks = childrenOf(revisions, revision.id).length}
        <li class:base={revision.id === $revisionState.baseRevisionId}>
          <div class="row">
            <span class="branch">{revision.branch}</span>
            <strong>{revision.label}</strong>
            {#if revision.id === $revisionState.baseRevisionId}<span class="badge">当前基点</span>{/if}
          </div>
          <small>
            {time(revision.createdAt)} · {revision.payload.group} · {revision.payload.objects.length} 个对象
            {#if revision.parentId}
              · 父 {shortRevisionId(revision.parentId)}
            {:else}
              · 根修订
            {/if}
            {#if forks > 1}· ⎇ {forks} 个分支点{/if}
          </small>
          <div class="actions">
            <button disabled={restoringId === revision.id} on:click={() => restore(revision.id)}>
              安全恢复
            </button>
            <button
              class:active={compareA === revision.id || compareB === revision.id}
              on:click={() => pickCompare(revision.id)}
            >
              对比
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  <h4>修订差异</h4>
  {#if compareA && compareB && diff}
    {@const from = revisionById(compareA)}
    {@const to = revisionById(compareB)}
    <div class="diff">
      <p class="note">
        {shortRevisionId(compareA)}（{from?.branch}） → {shortRevisionId(compareB)}（{to?.branch}）
      </p>
      {#if isEmptyDiff(diff)}
        <p class="empty">两个修订内容完全一致。</p>
      {:else}
        <ul>
          {#if diff.groupChanged}
            <li>墙纸群：{diff.groupChanged.from} → {diff.groupChanged.to}</li>
          {/if}
          {#if diff.cellChanged}
            <li>
              晶格尺寸：{diff.cellChanged.from[0]}×{diff.cellChanged.from[1]} →
              {diff.cellChanged.to[0]}×{diff.cellChanged.to[1]}
            </li>
          {/if}
          {#if diff.nameChanged}
            <li>工程名：{diff.nameChanged.from} → {diff.nameChanged.to}</li>
          {/if}
          {#each diff.objects as object (object.id)}
            {#if object.kind === 'added'}
              <li class="added">＋ 新增对象 {object.name}（{object.id.slice(-6)}）</li>
            {:else if object.kind === 'removed'}
              <li class="removed">－ 删除对象 {object.name}（{object.id.slice(-6)}）</li>
            {:else}
              <li class="modified">
                ＊ 修改 {object.name}（{object.id.slice(-6)}）：
                {[object.pathChanged ? '路径' : '', ...object.styleChanges].filter(Boolean).join('、')}
              </li>
            {/if}
          {/each}
        </ul>
      {/if}
    </div>
  {:else}
    <p class="empty">在时间线上点“对比”选择两个修订，查看群、晶格与对象差异。</p>
  {/if}
</section>

<style>
  .revisions {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  h3,
  h4 {
    margin: 0;
    font-size: 14px;
  }
  .note {
    margin: 0;
    color: #64748b;
    font-size: 12px;
    line-height: 1.5;
  }
  code {
    color: #0f172a;
  }
  .checkpoint {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px;
  }
  .error {
    margin: 0;
    padding: 8px;
    border-radius: 8px;
    background: #fff1f2;
    border: 1px solid #fecdd3;
    color: #be123c;
    font-size: 12px;
    line-height: 1.5;
  }
  .corrupt {
    display: grid;
    gap: 4px;
    padding: 8px;
    border-radius: 8px;
    background: #fffbeb;
    border: 1px solid #fde68a;
    color: #92400e;
    font-size: 12px;
  }
  .filter {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .empty {
    margin: 0;
    color: #94a3b8;
    font-size: 12px;
    line-height: 1.5;
  }
  .timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 7px;
  }
  .timeline li {
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 7px;
    display: grid;
    gap: 4px;
  }
  .timeline li.base {
    border-color: #1d4ed8;
    background: #eff6ff;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .branch {
    background: #e0e7ff;
    color: #3730a3;
    border-radius: 999px;
    padding: 1px 8px;
    font-size: 11px;
  }
  .badge {
    background: #1d4ed8;
    color: white;
    border-radius: 999px;
    padding: 1px 8px;
    font-size: 11px;
  }
  small {
    color: #64748b;
    display: block;
  }
  .actions {
    display: flex;
    gap: 6px;
  }
  .actions button.active {
    background: #1d4ed8;
    border-color: #1d4ed8;
    color: white;
  }
  .diff ul {
    margin: 6px 0 0;
    padding-left: 18px;
    font-size: 12px;
    display: grid;
    gap: 3px;
  }
  .added {
    color: #15803d;
  }
  .removed {
    color: #be123c;
  }
  .modified {
    color: #a16207;
  }
</style>
