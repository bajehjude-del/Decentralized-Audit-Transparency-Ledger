/**
 * KafkaEventBus — unit & integration tests
 */
import { KafkaEventBus, createKafkaEventBus } from "../KafkaEventBus";
import { createEventBus } from "../EventBusFactory";
import type { EventMessage } from "../types";

describe("KafkaEventBus", () => {
  it("throws a descriptive error when kafkajs is not installed", () => {
    // When kafkajs is not installed, instantiation must fail fast
    expect(() => {
      createKafkaEventBus({
        brokers: ["localhost:9092"],
      });
    }).toThrow(/Install kafkajs to use KafkaEventBus/i);
  });

  describe("with mocked kafkajs", () => {
    let bus: KafkaEventBus;
    let mockSend: jest.Mock;
    let mockConnect: jest.Mock;
    let mockDisconnect: jest.Mock;

    beforeEach(() => {
      mockSend = jest.fn().mockResolvedValue([]);
      mockConnect = jest.fn().mockResolvedValue(undefined);
      mockDisconnect = jest.fn().mockResolvedValue(undefined);

      jest.mock(
        "kafkajs",
        () => ({
          Kafka: jest.fn().mockImplementation(() => ({
            producer: () => ({
              connect: mockConnect,
              disconnect: mockDisconnect,
              send: mockSend,
            }),
            consumer: () => ({
              connect: jest.fn().mockResolvedValue(undefined),
              disconnect: jest.fn().mockResolvedValue(undefined),
              subscribe: jest.fn().mockResolvedValue(undefined),
              run: jest.fn().mockResolvedValue(undefined),
            }),
          })),
        }),
        { virtual: true },
      );

      bus = new KafkaEventBus({
        brokers: ["localhost:9092"],
        topic: "audit.test",
        clientId: "test-client",
      });
    });

    afterEach(async () => {
      jest.dontMock("kafkajs");
      await bus.close();
    });

    it("publishes events to Kafka and delivers to local subscribers", async () => {
      const received: EventMessage[] = [];
      bus.subscribe("contract.event_logged", async (msg) => {
        received.push(msg);
      });

      await bus.publish({
        type: "contract.event_logged",
        source: "relayer",
        version: 1,
        payload: { index: 1, eventType: "transfer" },
      });

      expect(mockConnect).toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: "audit.test",
          messages: expect.arrayContaining([
            expect.objectContaining({
              key: "contract.event_logged",
            }),
          ]),
        }),
      );

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("contract.event_logged");
      expect(bus.getMetrics().published).toBe(1);
      expect(bus.getMetrics().delivered).toBe(1);
    });

    it("supports historical event replay", async () => {
      await bus.publish({
        type: "metric.cpu",
        source: "monitor",
        version: 1,
        payload: { usage: 80 },
      });
      await bus.publish({
        type: "metric.ram",
        source: "monitor",
        version: 1,
        payload: { usage: 60 },
      });

      const replayed = await bus.replay({ types: ["metric.cpu"] });
      expect(replayed).toHaveLength(1);
      expect(replayed[0].type).toBe("metric.cpu");
    });

    it("closes producer and subscriptions cleanly", async () => {
      bus.subscribe("test", async () => {});
      await bus.publish({
        type: "test",
        source: "test",
        version: 1,
        payload: {},
      });

      await bus.close();
      expect(mockDisconnect).toHaveBeenCalled();
      expect(bus.getMetrics().activeSubscriptions).toBe(0);
    });
  });

  describe("EventBusFactory with Kafka backend", () => {
    it("routes backend 'kafka' to createKafkaEventBus", () => {
      expect(() => {
        createEventBus({
          backend: "kafka",
          kafka: { brokers: ["localhost:9092"] },
        });
      }).toThrow(/Install kafkajs to use KafkaEventBus/i);
    });

    it("resolves EVENT_BUS_BACKEND=kafka from env", () => {
      const original = process.env.EVENT_BUS_BACKEND;
      process.env.EVENT_BUS_BACKEND = "kafka";
      try {
        expect(() => createEventBus()).toThrow(/Install kafkajs to use KafkaEventBus/i);
      } finally {
        process.env.EVENT_BUS_BACKEND = original;
      }
    });
  });
});
