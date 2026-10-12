"""Собирает пакет для переноса текущей версии в исходники друга (TypeScript).
Результат: release-extras/v<версия>/DotaCoach-<версия>-update-for-friend.zip — его приложит workflow к релизу.
Пакет накопительный: изменения считаются от собранной 0.1.0 (reference/baseline-0.1.0).
Запуск из корня репозитория:  python tools/make_friend_kit.py
"""
import difflib, json, os, shutil, sys, tempfile, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "app")
BASE = os.path.join(ROOT, "reference", "baseline-0.1.0")
version = json.load(open(os.path.join(APP, "package.json"), encoding="utf-8"))["version"]
name = f"DotaCoach-{version}-update"


def files(root, sub):
    out = {}
    base = os.path.join(root, sub)
    if os.path.isfile(base):
        return {sub: base}
    for d, _, fs in os.walk(base):
        for f in fs:
            p = os.path.join(d, f)
            out[os.path.relpath(p, root).replace(os.sep, "/")] = p
    return out


def text(p):
    try:
        return open(p, encoding="utf-8").read().splitlines(keepends=True)
    except UnicodeDecodeError:
        return None


tmp = tempfile.mkdtemp()
kit = os.path.join(tmp, name)
os.makedirs(os.path.join(kit, "diff"))
prompt = open(os.path.join(ROOT, "docs", "CLAUDE_PROMPT.md"), encoding="utf-8").read().replace("{VERSION}", version)
open(os.path.join(kit, "CLAUDE_PROMPT.md"), "w", encoding="utf-8").write(prompt)
shutil.copy(os.path.join(ROOT, "docs", "PORTING.md"), os.path.join(kit, "PORTING.md"))
for sub in ("out", "package.json"):
    src = os.path.join(APP, sub)
    dst = os.path.join(kit, "reference", "app", sub)
    shutil.copytree(src, dst) if os.path.isdir(src) else (os.makedirs(os.path.dirname(dst), exist_ok=True), shutil.copy(src, dst))
shutil.copytree(BASE, os.path.join(kit, "reference", "baseline-0.1.0"))

new, changed, removed = [], [], []
cur = {**files(APP, "out"), **files(APP, "package.json")}
old = {**files(BASE, "out"), **files(BASE, "package.json")}
for rel in sorted(set(cur) | set(old)):
    if rel not in old:
        new.append(rel)
        continue
    if rel not in cur:
        removed.append(rel)
        continue
    a, b = text(old[rel]), text(cur[rel])
    if a is None or b is None or a == b:
        continue
    changed.append(rel)
    diff = difflib.unified_diff(a, b, f"a/{rel}", f"b/{rel}", n=3)
    fname = rel.replace("/", "__") + ".diff"
    open(os.path.join(kit, "diff", fname), "w", encoding="utf-8").writelines(diff)
open(os.path.join(kit, "diff", "new-files.txt"), "w", encoding="utf-8").write(
    "Новые файлы (их нет в 0.1.0, целиком лежат в reference/app/):\n" + "".join(f"  {f}\n" for f in new)
    + ("\nУдалённые файлы:\n" + "".join(f"  {f}\n" for f in removed) if removed else ""))

out_dir = os.path.join(ROOT, "release-extras", f"v{version}")
os.makedirs(out_dir, exist_ok=True)
zpath = os.path.join(out_dir, f"{name}-for-friend.zip".replace("-update-for-friend", "-update-for-friend"))
with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
    for d, _, fs in os.walk(kit):
        for f in fs:
            p = os.path.join(d, f)
            z.write(p, os.path.relpath(p, tmp))
shutil.rmtree(tmp)
print(f"{os.path.relpath(zpath, ROOT)}  {os.path.getsize(zpath)} байт")
print(f"  изменённых файлов: {len(changed)}, новых: {len(new)}, удалённых: {len(removed)}")
