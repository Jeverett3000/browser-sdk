import {
  combine,
  generateUUID,
  RequestType,
  ResourceType,
  toServerDuration,
  relativeToClocks,
  assign,
} from '@datadog/browser-core'
import type { RumConfiguration } from '../../configuration'
import type { RumPerformanceEntry, RumPerformanceResourceTiming } from '../../../browser/performanceCollection'
import { supportPerformanceEntry } from '../../../browser/performanceCollection'
import type {
  PerformanceEntryRepresentation,
  RumXhrResourceEventDomainContext,
  RumFetchResourceEventDomainContext,
} from '../../../domainContext.types'
import type { RawRumResourceEvent } from '../../../rawRumEvent.types'
import { RumEventType } from '../../../rawRumEvent.types'
import type { LifeCycle, RawRumEventCollectedData } from '../../lifeCycle'
import { LifeCycleEventType } from '../../lifeCycle'
import type { RequestCompleteEvent } from '../../requestCollection'
import { matchRequestTiming } from './matchRequestTiming'
import {
  computePerformanceResourceDetails,
  computePerformanceResourceDuration,
  computeResourceKind,
  computeSize,
  isRequestKind,
} from './resourceUtils'

export function startResourceCollection(lifeCycle: LifeCycle, configuration: RumConfiguration) {
  lifeCycle.subscribe(LifeCycleEventType.REQUEST_COMPLETED, (request: RequestCompleteEvent) => {
    lifeCycle.notify(LifeCycleEventType.RAW_RUM_EVENT_COLLECTED, processRequest(request, configuration))
  })

  lifeCycle.subscribe(LifeCycleEventType.PERFORMANCE_ENTRIES_COLLECTED, (entries) => {
    for (const entry of entries) {
      if (entry.entryType === 'resource' && !isRequestKind(entry)) {
        lifeCycle.notify(LifeCycleEventType.RAW_RUM_EVENT_COLLECTED, processResourceEntry(entry, configuration))
      }
    }
  })
}

function processRequest(
  request: RequestCompleteEvent,
  configuration: RumConfiguration
): RawRumEventCollectedData<RawRumResourceEvent> {
  const type = request.type === RequestType.XHR ? ResourceType.XHR : ResourceType.FETCH

  const matchingTiming = matchRequestTiming(request)
  const startClocks = matchingTiming ? relativeToClocks(matchingTiming.startTime) : request.startClocks
  const correspondingTimingOverrides = matchingTiming ? computePerformanceEntryMetrics(matchingTiming) : undefined

  const tracingInfo = computeRequestTracingInfo(request, configuration)

  const resourceEvent = combine(
    {
      date: startClocks.timeStamp,
      resource: {
        id: generateUUID(),
        type,
        duration: toServerDuration(request.duration),
        method: request.method,
        status_code: request.status,
        url: request.url,
      },
      type: RumEventType.RESOURCE as const,
    },
    tracingInfo,
    correspondingTimingOverrides
  )
  return {
    startTime: startClocks.relative,
    rawRumEvent: resourceEvent,
    domainContext: {
      performanceEntry: matchingTiming && toPerformanceEntryRepresentation(matchingTiming),
      xhr: request.xhr,
      response: request.response,
      requestInput: request.input,
      requestInit: request.init,
      error: request.error,
    } as RumFetchResourceEventDomainContext | RumXhrResourceEventDomainContext,
  }
}

function processResourceEntry(
  entry: RumPerformanceResourceTiming,
  configuration: RumConfiguration
): RawRumEventCollectedData<RawRumResourceEvent> {
  const type = computeResourceKind(entry)
  const entryMetrics = computePerformanceEntryMetrics(entry)

  const tracingInfo = computeEntryTracingInfo(entry, configuration)

  const startClocks = relativeToClocks(entry.startTime)
  const resourceEvent = combine(
    {
      date: startClocks.timeStamp,
      resource: {
        id: generateUUID(),
        type,
        url: entry.name,
      },
      type: RumEventType.RESOURCE as const,
    },
    tracingInfo,
    entryMetrics
  )
  return {
    startTime: startClocks.relative,
    rawRumEvent: resourceEvent,
    domainContext: {
      performanceEntry: toPerformanceEntryRepresentation(entry),
    },
  }
}

function computePerformanceEntryMetrics(timing: RumPerformanceResourceTiming) {
  return {
    resource: assign(
      {
        duration: computePerformanceResourceDuration(timing),
        size: computeSize(timing),
      },
      computePerformanceResourceDetails(timing)
    ),
  }
}

function computeRequestTracingInfo(request: RequestCompleteEvent, configuration: RumConfiguration) {
  const hasBeenTraced = request.traceSampled && request.traceId && request.spanId
  if (!hasBeenTraced) {
    return undefined
  }
  return {
    _dd: {
      span_id: request.spanId!.toDecimalString(),
      trace_id: request.traceId!.toDecimalString(),
      rule_psr: getRulePsr(configuration),
    },
  }
}

function computeEntryTracingInfo(entry: RumPerformanceResourceTiming, configuration: RumConfiguration) {
  const hasBeenTraced = entry.traceId
  if (!hasBeenTraced) {
    return undefined
  }
  return {
    _dd: {
      trace_id: entry.traceId,
      rule_psr: getRulePsr(configuration),
    },
  }
}

function toPerformanceEntryRepresentation(entry: RumPerformanceEntry): PerformanceEntryRepresentation {
  if (supportPerformanceEntry() && entry instanceof PerformanceEntry) {
    entry.toJSON()
  }
  return entry as PerformanceEntryRepresentation
}

/**
 * @returns number between 0 and 1 which represents tracing sample rate
 */
function getRulePsr(configuration: RumConfiguration) {
  return configuration.tracingSampleRate / 100
}
