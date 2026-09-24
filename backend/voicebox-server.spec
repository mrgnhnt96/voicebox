# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules
from PyInstaller.utils.hooks import collect_all
from PyInstaller.utils.hooks import copy_metadata

datas = []
binaries = []
hiddenimports = ['backend', 'backend.main', 'backend.config', 'backend.database', 'backend.models', 'backend.services.transcribe', 'backend.utils.platform_detect', 'backend.backends', 'backend.backends.qwen_llm_backend', 'backend.utils.audio', 'backend.utils.progress', 'backend.utils.hf_progress', 'transformers', 'fastapi', 'uvicorn', 'uvicorn.protocols.websockets.auto', 'uvicorn.protocols.websockets.websockets_impl', 'sqlalchemy', 'soundfile', 'requests', 'pkg_resources.extern', 'backend.backends.mlx_backend', 'mlx', 'mlx.core', 'mlx.nn', 'mlx_audio', 'mlx_audio.stt', 'mlx_lm']
datas += copy_metadata('requests')
datas += copy_metadata('transformers')
datas += copy_metadata('huggingface-hub')
datas += copy_metadata('tokenizers')
datas += copy_metadata('safetensors')
datas += copy_metadata('tqdm')
hiddenimports += collect_submodules('backend.services')
hiddenimports += collect_submodules('websockets')
hiddenimports += collect_submodules('jaraco')
hiddenimports += collect_submodules('mlx')
hiddenimports += collect_submodules('mlx_audio')
hiddenimports += collect_submodules('mlx_lm')
tmp_ret = collect_all('lazy_loader')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('librosa')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('mlx')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('mlx_audio')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('mlx_lm')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    ['server.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=['pyi_hooks'],
    hooksconfig={},
    runtime_hooks=['pyi_rth_scipy_distn.py'],
    excludes=['torch', 'torchaudio', 'torchvision'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='voicebox-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
