"""
PyInstaller runtime hook: let scipy.stats._distn_infrastructure load when frozen.

That module ends with:

    for obj in [s for s in dir() if s.startswith('_doc_')]:
        exec('del ' + obj)
    del obj

In the PyInstaller bundle the list comprehension evaluates to empty
(module-level dir() under the frozen importer returns a different scope than
CPython's normal module-exec path). The loop body never runs, ``obj`` is never
bound, and the trailing ``del obj`` raises NameError at module load. That kills
librosa (used to decode captures) -> scipy.signal -> scipy.stats -> here.

The fix delegates to the real loader, but reads the module's source and
replaces ``del obj`` with a variant that survives an unbound name before
compiling it. The source must be bundled next to the .pyc; see
backend/pyi_hooks/hook-scipy.stats._distn_infrastructure.py.
"""

import os
import sys
import tempfile

# Runtime hook prints go nowhere when the server runs as a sidecar, so log
# hook activity to a file. Safe no-op if the file can't be written.
_DIAG_PATH = os.path.join(tempfile.gettempdir(), "voicebox_rt_hook.log")
_TARGET = "scipy.stats._distn_infrastructure"


def _diag(msg: str) -> None:
    try:
        with open(_DIAG_PATH, "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def _patch_source(source: str) -> str:
    """Replace the unsafe ``del obj`` with a no-op when ``obj`` is unbound."""
    return source.replace("\ndel obj\n", "\nglobals().pop('obj', None)\n", 1)


class _ScipyDistnPatchingFinder:
    """Find the real spec through the other finders and wrap its loader."""

    def find_spec(self, fullname, path=None, target=None):
        if fullname != _TARGET:
            return None
        for finder in sys.meta_path:
            if finder is self:
                continue
            find = getattr(finder, "find_spec", None)
            if find is None:
                continue
            try:
                real_spec = find(fullname, path, target)
            except Exception as e:
                _diag(f"[scipy-finder] {type(finder).__name__} raised: {e!r}")
                continue
            if real_spec is None or real_spec.loader is None:
                continue
            real_spec.loader = _ScipyDistnLoader(real_spec.loader)
            return real_spec
        _diag("[scipy-finder] no inner finder returned a spec")
        return None


class _ScipyDistnLoader:
    """Delegate loader that execs the patched source instead of the .pyc.

    Every other attribute forwards to the inner PyInstaller loader, so
    get_source/get_filename/is_package/etc. keep working.
    """

    def __init__(self, inner):
        self._inner = inner

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def create_module(self, spec):
        return self._inner.create_module(spec)

    def exec_module(self, module):
        source = None
        try:
            source = self._inner.get_source(module.__name__)
        except Exception as e:
            _diag(f"[scipy-loader] get_source failed: {e!r}")

        if not source:
            # Best effort without source: pre-bind the name and hope the
            # frozen bytecode sees it.
            _diag("[scipy-loader] no source; falling back to pre-bind")
            module.__dict__["obj"] = None
            self._inner.exec_module(module)
            return

        spec = module.__spec__
        if spec is not None and spec.submodule_search_locations is not None:
            module.__path__ = spec.submodule_search_locations
        filename = getattr(self._inner, "path", module.__name__)
        exec(compile(_patch_source(source), filename, "exec"), module.__dict__)


try:
    sys.meta_path.insert(0, _ScipyDistnPatchingFinder())
except Exception as _e:
    _diag(f"installing scipy finder failed: {_e!r}")
