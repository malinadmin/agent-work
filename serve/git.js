import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function git(workdir, args) {
  return (await exec('git', args, { cwd: workdir, timeout: 10000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout;
}

export async function readBranches(workdir) {
  try {
    await git(workdir, ['rev-parse', '--show-toplevel']);
    const [head, refs, status] = await Promise.all([
      git(workdir, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
      git(workdir, ['for-each-ref', '--format=%(refname:short)\t%(worktreepath)', 'refs/heads/']),
      git(workdir, ['status', '--porcelain', '--untracked-files=normal']),
    ]);
    const current = head.trim();
    const branches = refs.trimEnd().split('\n').filter(Boolean).map(line => {
      const [name, path = ''] = line.split('\t');
      return { name, occupied: Boolean(path) && name !== current };
    });
    return { available: true, current, detached: !current, dirty: Boolean(status), branches };
  } catch {
    return { available: false, current: '', detached: false, dirty: false, branches: [], reason: '当前目录不是 Git 仓库，或无法读取分支' };
  }
}

export async function switchBranch(workdir, branch, expectedBranch) {
  if (typeof branch !== 'string' || !branch || branch.startsWith('-') || /[\r\n\0]/.test(branch)) throw new Error('分支名称无效');
  const state = await readBranches(workdir);
  if (!state.available) throw new Error(state.reason);
  if (state.current !== expectedBranch) throw new Error('当前分支已变化，请刷新后重试');
  if (state.current === branch) return state;
  if (state.dirty) throw new Error('工作区有未提交变更（含新增文件），请先提交或自行暂存后再切换分支');
  const target = state.branches.find(item => item.name === branch);
  if (!target) throw new Error('只能切换到已存在的本地分支');
  if (target.occupied) throw new Error('目标分支已在其他 Git worktree 中使用');
  try { await git(workdir, ['switch', '--no-guess', branch]); }
  catch { throw new Error('Git 拒绝切换分支：请检查工作区变更、合并状态或 worktree 占用；未强制切换或丢弃文件'); }
  return readBranches(workdir);
}
