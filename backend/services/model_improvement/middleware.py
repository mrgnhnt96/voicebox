"""Foreground requests preempt background GPU work before dispatch."""

import asyncio


class ForegroundPriorityMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        foreground = False
        if scope["type"] == "http" and scope.get("method") in ("POST", "PUT", "PATCH", "DELETE"):
            path = scope.get("path", "")
            if not path.startswith("/capture/learning"):
                from .manager import begin_foreground

                await asyncio.to_thread(begin_foreground)
                foreground = True
        try:
            await self.app(scope, receive, send)
        finally:
            if foreground:
                from .manager import end_foreground

                end_foreground()
