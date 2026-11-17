import { inspectTarget, localBranches, validateBranch } from './git.js';

export async function chooseBranches(repo, options, { interactive, ask, print }) {
  const selected = { ...options };
  if (!interactive) {
    if (!selected.from && !selected.source) throw new Error('Укажите --source <исходная-ветка> или --from <каталог>');
    if (!selected.target) throw new Error('Укажите --target <целевая-локальная-ветка>');
    return selected;
  }
  const state = await inspectTarget(repo.targetDir);
  if (!selected.from && !selected.source) {
    while (!selected.source) {
      const answer = await ask('Откуда: имя ветки внешнего репозитория');
      try { validateBranch(answer); selected.source = answer; }
      catch { print('Введите корректное имя исходной ветки. Значения по умолчанию нет.'); }
    }
  }
  if (!selected.target) {
    const branches = localBranches(state.target);
    print('Куда: выберите существующую локальную ветку внутреннего репозитория:');
    branches.forEach((branch, index) => print(`  ${index + 1}. ${branch}${branch === state.branch ? ' (текущая)' : ''}`));
    while (!selected.target) {
      const answer = await ask('Номер или имя целевой ветки');
      const index = /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
      selected.target = branches.includes(answer) ? answer : branches[index];
      if (!selected.target) print('Выберите ветку из списка. Новые ветки автоматически не создаются.');
    }
  }
  return selected;
}
