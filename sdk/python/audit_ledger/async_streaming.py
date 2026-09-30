"""Asynchronous streaming and event batching utilities for AuditLedger (#392).

Provides:
- :func:`async_stream_events`   — async generator yielding events in real-time.
- :func:`async_stream_by_type`  — convenience async generator filtered to one event type.
- :class:`AsyncEventBatcher`    — automatic batching of event submissions.
"""

from __future__ import annotations

import asyncio
import time
from typing import (
    TYPE_CHECKING,
    Any,
    AsyncGenerator,
    Callable,
    Dict,
    List,
    Optional,
)

from .models import Event, EventType
from .streaming import StreamConfig, StreamError

if TYPE_CHECKING:
    from .async_client import AsyncAuditLedgerClient


__all__ = [
    "async_stream_events",
    "async_stream_by_type",
    "AsyncEventBatcher",
]


async def async_stream_events(
    client: "AsyncAuditLedgerClient",
    after_index: int = 0,
    config: Optional[StreamConfig] = None,
) -> AsyncGenerator[Event, None]:
    """Asynchronously yield :class:`~audit_ledger.models.Event` objects as they are logged.

    Args:
        client: An initialised :class:`~audit_ledger.async_client.AsyncAuditLedgerClient`.
        after_index: Cursor position to start streaming from.
        config: Optional streaming configuration.

    Yields:
        :class:`~audit_ledger.models.Event` in order.
    """
    cfg = config or StreamConfig()
    cursor: int = after_index
    consecutive_errors: int = 0
    current_wait: float = cfg.poll_interval_s

    while True:
        try:
            total: int = await client.total_events()
            consecutive_errors = 0
            current_wait = cfg.poll_interval_s
        except Exception as exc:
            consecutive_errors += 1
            if cfg.max_errors > 0 and consecutive_errors >= cfg.max_errors:
                raise StreamError(consecutive_errors, exc) from exc
            current_wait = min(current_wait * cfg.backoff_factor, cfg.max_backoff_s)
            await asyncio.sleep(current_wait)
            continue

        fetched: int = 0
        while cursor < total:
            try:
                event: Event = await client.get_event_by_order(cursor)
                consecutive_errors = 0
            except Exception as exc:
                consecutive_errors += 1
                if cfg.max_errors > 0 and consecutive_errors >= cfg.max_errors:
                    raise StreamError(consecutive_errors, exc) from exc
                current_wait = min(current_wait * cfg.backoff_factor, cfg.max_backoff_s)
                await asyncio.sleep(current_wait)
                break

            cursor += 1
            fetched += 1

            # Check filters
            if cfg.event_type_filter and event.event_type != cfg.event_type_filter:
                continue
            if cfg.predicate and not cfg.predicate(event):
                continue

            yield event

            if cfg.batch_size > 0 and fetched >= cfg.batch_size:
                break

        await asyncio.sleep(cfg.poll_interval_s)


async def async_stream_by_type(
    client: "AsyncAuditLedgerClient",
    event_type: EventType,
    after_index: int = 0,
    config: Optional[StreamConfig] = None,
) -> AsyncGenerator[Event, None]:
    """Yield events of a single type asynchronously."""
    merged = StreamConfig(
        poll_interval_s=(config.poll_interval_s if config else 5.0),
        batch_size=(config.batch_size if config else 0),
        event_type_filter=event_type,
        predicate=(config.predicate if config else None),
        max_errors=(config.max_errors if config else 10),
        backoff_factor=(config.backoff_factor if config else 2.0),
        max_backoff_s=(config.max_backoff_s if config else 60.0),
    )
    async for event in async_stream_events(client, after_index=after_index, config=merged):
        yield event


class AsyncEventBatcher:
    """Automatic batching utility for asynchronous event submissions."""

    def __init__(
        self,
        submit_fn: Callable[[List[Dict[str, Any]]], Any],
        max_batch_size: int = 50,
        max_wait_s: float = 0.05,
    ) -> None:
        self.submit_fn = submit_fn
        self.max_batch_size = max(1, max_batch_size)
        self.max_wait_s = max(0.001, max_wait_s)
        self._queue: List[Dict[str, Any]] = []
        self._futures: List[asyncio.Future[Any]] = []
        self._timer_task: Optional[asyncio.Task[None]] = None
        self._lock = asyncio.Lock()

    async def queue_event(self, event_data: Dict[str, Any]) -> Any:
        """Enqueue an event and return a future that resolves with its submission result."""
        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()

        async with self._lock:
            self._queue.append(event_data)
            self._futures.append(future)

            if len(self._queue) >= self.max_batch_size:
                if self._timer_task and not self._timer_task.done():
                    self._timer_task.cancel()
                    self._timer_task = None
                loop.create_task(self._flush_internal())
            elif self._timer_task is None or self._timer_task.done():
                self._timer_task = loop.create_task(self._delay_flush())

        return await future

    async def _delay_flush(self) -> None:
        try:
            await asyncio.sleep(self.max_wait_s)
            async with self._lock:
                await self._flush_internal()
        except asyncio.CancelledError:
            pass

    async def _flush_internal(self) -> None:
        if not self._queue:
            return

        batch_items = self._queue[:]
        futures = self._futures[:]
        self._queue.clear()
        self._futures.clear()

        try:
            results = await self.submit_fn(batch_items)
            for i, fut in enumerate(futures):
                if not fut.done():
                    res = results[i] if isinstance(results, list) and i < len(results) else results
                    fut.set_result(res)
        except Exception as exc:
            for fut in futures:
                if not fut.done():
                    fut.set_exception(exc)

    async def flush(self) -> None:
        """Manually trigger flush of all enqueued events."""
        async with self._lock:
            if self._timer_task and not self._timer_task.done():
                self._timer_task.cancel()
                self._timer_task = None
            await self._flush_internal()
