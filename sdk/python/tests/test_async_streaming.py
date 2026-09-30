"""Tests for Python SDK async streaming and batching utilities (#392)."""

import asyncio
import pytest
from audit_ledger.async_streaming import (
    async_stream_events,
    async_stream_by_type,
    AsyncEventBatcher,
)
from audit_ledger.models import Event
from audit_ledger.streaming import StreamConfig


class FakeAsyncClient:
    def __init__(self, events):
        self._events = events

    async def total_events(self):
        return len(self._events)

    async def get_event_by_order(self, index):
        return self._events[index]


@pytest.mark.asyncio
async def test_async_stream_events():
    mock_events = [
        Event(index=0, timestamp=100, event_type="audit", submitter="alice", metadata="m0", event_hash="h0", prev_hash="p0"),
        Event(index=1, timestamp=101, event_type="transfer", submitter="bob", metadata="m1", event_hash="h1", prev_hash="p1"),
        Event(index=2, timestamp=102, event_type="audit", submitter="charlie", metadata="m2", event_hash="h2", prev_hash="p2"),
    ]
    client = FakeAsyncClient(mock_events)

    cfg = StreamConfig(poll_interval_s=0.01, batch_size=2)
    stream = async_stream_events(client, after_index=0, config=cfg)

    received = []
    async for event in stream:
        received.append(event)
        if len(received) >= 3:
            break

    assert len(received) == 3
    assert received[0].index == 0
    assert received[1].event_type == "transfer"
    assert received[2].submitter == "charlie"


@pytest.mark.asyncio
async def test_async_event_batcher():
    submitted_batches = []

    async def mock_submit(batch):
        submitted_batches.append(batch)
        return [f"tx_{item['id']}" for item in batch]

    batcher = AsyncEventBatcher(mock_submit, max_batch_size=3, max_wait_s=0.5)

    res = await asyncio.gather(
        batcher.queue_event({"id": 1}),
        batcher.queue_event({"id": 2}),
        batcher.queue_event({"id": 3}),
    )

    assert len(submitted_batches) == 1
    assert len(submitted_batches[0]) == 3
    assert res == ["tx_1", "tx_2", "tx_3"]
