"""
Fire-and-forget background tasks that are kept alive until they finish.
"""

import asyncio

# Keep references to fire-and-forget background tasks to prevent GC
_background_tasks: set = set()


def create_background_task(coro) -> asyncio.Task:
    """Create a background task and prevent it from being garbage collected."""
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task
