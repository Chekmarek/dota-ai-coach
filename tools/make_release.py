"""Собирает файлы релиза в dist/: app.asar, app.asar.sha256 и архив для ручной установки.
Запуск из корня репозитория:  python tools/make_release.py
"""
import hashlib, json, os, shutil, sys, zipfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from asarpack import build  # noqa: E402

app = os.path.join(ROOT, "app")
version = json.load(open(os.path.join(app, "package.json"), encoding="utf-8"))["version"]
dist = os.path.join(ROOT, "dist")
shutil.rmtree(dist, ignore_errors=True)
os.makedirs(dist)
asar = os.path.join(dist, "app.asar")
build(app, asar)
digest = hashlib.sha256(open(asar, "rb").read()).hexdigest()
open(asar + ".sha256", "w").write(f"{digest}  app.asar\n")
bundle = os.path.join(dist, f"DotaCoach-{version}-update.zip")
with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(asar, f"DotaCoach-{version}/app.asar")
    for f in ("install.bat", "rollback.bat"):
        z.write(os.path.join(ROOT, "installer", f), f"DotaCoach-{version}/{f}")
print(f"v{version}  sha256={digest}")
for f in sorted(os.listdir(dist)):
    print(f"  dist/{f}  {os.path.getsize(os.path.join(dist, f))} байт")
