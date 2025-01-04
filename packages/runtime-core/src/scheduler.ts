import { ErrorCodes, callWithErrorHandling, handleError } from './errorHandling'
import { NOOP, isArray } from '@vue/shared'
import { type ComponentInternalInstance, getComponentName } from './component'

export enum SchedulerJobFlags {
  QUEUED = 1 << 0,
  PRE = 1 << 1,
  /**
   * Indicates whether the effect is allowed to recursively trigger itself
   * when managed by the scheduler.
   *
   * By default, a job cannot trigger itself because some built-in method calls,
   * e.g. Array.prototype.push actually performs reads as well (#1740) which
   * can lead to confusing infinite loops.
   * The allowed cases are component update functions and watch callbacks.
   * Component update functions may update child component props, which in turn
   * trigger flush: "pre" watch callbacks that mutates state that the parent
   * relies on (#1801). Watch callbacks doesn't track its dependencies so if it
   * triggers itself again, it's likely intentional and it is the user's
   * responsibility to perform recursive state mutation that eventually
   * stabilizes (#1727).
   */
  ALLOW_RECURSE = 1 << 2,
  DISPOSED = 1 << 3,
}

export interface SchedulerJob extends Function {
  id?: number
  position?: number
  /**
   * flags can technically be undefined, but it can still be used in bitwise
   * operations just like 0.
   */
  flags?: SchedulerJobFlags
  /**
   * Attached by renderer.ts when setting up a component's render effect
   * Used to obtain component information when reporting max recursive updates.
   */
  i?: ComponentInternalInstance
}

export type SchedulerJobs = SchedulerJob | SchedulerJob[]
let auto = true

const queue: SchedulerJob[] = []
let flushIndex = -1

const pendingPostFlushCbs: SchedulerJob[] = []
let activePostFlushCbs: SchedulerJob[] | null = null
let postFlushIndex = 0

const resolvedPromise = /*@__PURE__*/ Promise.resolve() as Promise<any>
let currentFlushPromise: Promise<void[]> | null = null

const RECURSION_LIMIT = 100
type CountMap = Map<SchedulerJob, number>

export function nextTick<T = void, R = void>(
  this: T,
  fn?: (this: T) => R,
): Promise<Awaited<R>> {
  const p = currentFlushPromise || resolvedPromise
  return fn ? p.then(this ? fn.bind(this) : fn) : p
}

// Use binary-search to find a suitable position in the queue. The queue needs
// to be sorted in increasing order of the job ids. This ensures that:
// 1. Components are updated from parent to child. As the parent is always
//    created before the child it will always have a smaller id.
// 2. If a component is unmounted during a parent component's update, its update
//    can be skipped.
// A pre watcher will have the same id as its component's update job. The
// watcher should be inserted immediately before the update job. This allows
// watchers to be skipped if the component is unmounted by the parent update.
function findInsertionIndex(id: number) {
  let start = flushIndex + 1
  let end = queue.length

  while (start < end) {
    const middle = (start + end) >>> 1
    const middleJob = queue[middle]
    const middleJobId = getId(middleJob)
    if (
      middleJobId < id ||
      (middleJobId === id && middleJob.flags! & SchedulerJobFlags.PRE)
    ) {
      start = middle + 1
    } else {
      end = middle
    }
  }

  return start
}

export function queueJob(job: SchedulerJob): number {
  let index = -1
  if (!(job.flags! & SchedulerJobFlags.QUEUED)) {
    const jobId = getId(job)
    const lastJob = queue[queue.length - 1]
    if (
      !lastJob ||
      // fast path when the job id is larger than the tail
      (!(job.flags! & SchedulerJobFlags.PRE) && jobId >= getId(lastJob))
    ) {
      index = queue.length
      queue.push(job)
    } else {
      index = findInsertionIndex(jobId)
      queue.splice(index, 0, job)
    }

    job.flags! |= SchedulerJobFlags.QUEUED

    queueFlush()
  }
  return index
}

export function toggleMode(): void {
  auto = !auto
}

let controllers = 0

export function getMode(): 'auto' | 'manual' {
  return auto ? 'auto' : 'manual'
}

export function switchToAuto(): void {
  controllers = Math.max(controllers - 1, 0)
  if (controllers > 0) {
    return
  }

  if (queue.length || pendingPostFlushCbs.length) {
    try {
      flushPreFlushCbs()
    } finally {
      // If there was an error we still need to clear the QUEUED flags
      for (; flushIndex < queue.length; flushIndex++) {
        const job = queue[flushIndex]
        if (job) {
          job.flags! &= ~SchedulerJobFlags.QUEUED
        }
      }

      flushIndex = 0
      queue.length = 0

      flushPostFlushCbs(seen)

      endFlush()
      isFlushing = false
      currentFlushPromise = null
      // some postFlushCb queued jobs!
      // keep flushing until it drains.
      if (queue.length || pendingPostFlushCbs.length) {
        flushJobs(seen)
      }
      auto = true
    }
  } else {
    flushIndex = 0
    endFlush()
    isFlushing = false
    currentFlushPromise = null
    activePostFlushCbs = null
    postFlushIndex = 0
    auto = true
  }
}

export function switchToManual(): void {
  controllers++
  queueFlush()
  auto = false
}

let endFlushImpl = NOOP
function trackManualFlush() {
  return new Promise<void>(resolve => {
    endFlushImpl = () => {
      resolve()
      auto = true
      endFlushImpl = NOOP
    }
  })
}

export function endFlush(): void {
  endFlushImpl()
}

function queueFlush() {
  if (!currentFlushPromise) {
    currentFlushPromise = Promise.all([
      resolvedPromise.then(flushJobs),
      trackManualFlush(),
    ])
  }
}

export function queuePostFlushCb(cb: SchedulerJobs): {
  offset: number
  length: number
} {
  const indexes = {
    offset: 0,
    length: 0,
  }
  if (!isArray(cb)) {
    if (activePostFlushCbs && cb.id === -1) {
      indexes.offset = postFlushIndex
      indexes.length = 1
      activePostFlushCbs.splice(postFlushIndex + 1, 0, cb)
    } else if (!(cb.flags! & SchedulerJobFlags.QUEUED)) {
      indexes.offset = pendingPostFlushCbs.length
      indexes.length = 1
      pendingPostFlushCbs.push(cb)
      cb.flags! |= SchedulerJobFlags.QUEUED
    }
  } else {
    // if cb is an array, it is a component lifecycle hook which can only be
    // triggered by a job, which is already deduped in the main queue, so
    // we can skip duplicate check here to improve perf
    indexes.offset = pendingPostFlushCbs.length
    indexes.length = cb.length
    pendingPostFlushCbs.push(...cb)
  }
  queueFlush()
  return indexes
}

export function flushPreFlushCbs(
  instance?: ComponentInternalInstance,
  seen?: CountMap,
  // skip the current job
  i: number = flushIndex + 1,
): void {
  if (__DEV__) {
    seen = seen || new Map()
  }
  for (; i < queue.length; i++) {
    const cb = queue[i]
    if (cb && cb.flags! & SchedulerJobFlags.PRE) {
      if (instance && cb.id !== instance.uid) {
        continue
      }
      if (__DEV__ && checkRecursiveUpdates(seen!, cb)) {
        continue
      }
      queue.splice(i, 1)
      i--
      if (cb.flags! & SchedulerJobFlags.ALLOW_RECURSE) {
        cb.flags! &= ~SchedulerJobFlags.QUEUED
      }
      cb()
      if (!(cb.flags! & SchedulerJobFlags.ALLOW_RECURSE)) {
        cb.flags! &= ~SchedulerJobFlags.QUEUED
      }
    }
  }
}

export function flushPostFlushCbs(seen?: CountMap): void {
  if (pendingPostFlushCbs.length) {
    const deduped = [...new Set(pendingPostFlushCbs)].sort(
      (a, b) => getId(a) - getId(b),
    )
    pendingPostFlushCbs.length = 0

    // #1947 already has active queue, nested flushPostFlushCbs call
    if (activePostFlushCbs) {
      activePostFlushCbs.push(...deduped)
      return
    }

    activePostFlushCbs = deduped
    if (__DEV__) {
      seen = seen || new Map()
    }

    for (
      postFlushIndex = 0;
      postFlushIndex < activePostFlushCbs.length;
      postFlushIndex++
    ) {
      const cb = activePostFlushCbs[postFlushIndex]
      if (__DEV__ && checkRecursiveUpdates(seen!, cb)) {
        continue
      }
      if (cb.flags! & SchedulerJobFlags.ALLOW_RECURSE) {
        cb.flags! &= ~SchedulerJobFlags.QUEUED
      }
      if (!(cb.flags! & SchedulerJobFlags.DISPOSED)) cb()
      cb.flags! &= ~SchedulerJobFlags.QUEUED
    }
    activePostFlushCbs = null
    postFlushIndex = 0
  }
}

const getId = (job: SchedulerJob): number =>
  job.id == null ? (job.flags! & SchedulerJobFlags.PRE ? -1 : Infinity) : job.id

export function getJobAt(index: number): SchedulerJob | undefined {
  return queue[index]
}

let seen: CountMap
if (__DEV__) {
  seen = new Map()
}

const check = __DEV__
  ? (job: SchedulerJob) => checkRecursiveUpdates(seen!, job)
  : NOOP

export function flushJobsUntil(index: number): void {
  try {
    for (; flushIndex <= index; flushIndex++) {
      const job = queue[flushIndex]
      if (job && !(job.flags! & SchedulerJobFlags.DISPOSED)) {
        if (__DEV__ && check(job)) {
          return
        }
        if (job.flags! & SchedulerJobFlags.ALLOW_RECURSE) {
          job.flags! &= ~SchedulerJobFlags.QUEUED
        }
        callWithErrorHandling(
          job,
          job.i,
          job.i ? ErrorCodes.COMPONENT_UPDATE : ErrorCodes.SCHEDULER,
        )
        job.flags! &= ~SchedulerJobFlags.QUEUED
      }
    }
  } catch {}
}

function getActivePostFlushCbs() {
  const deduped = [...new Set(pendingPostFlushCbs)].sort(
    (a, b) => getId(a) - getId(b),
  )
  pendingPostFlushCbs.length = 0

  // #1947 already has active queue, nested flushPostFlushCbs call
  if (activePostFlushCbs) {
    activePostFlushCbs.push(...deduped)
    return activePostFlushCbs
  }

  activePostFlushCbs = deduped
  return activePostFlushCbs
}
export function flushPostJobsUntil(index: number, clear: boolean = true): void {
  activePostFlushCbs = getActivePostFlushCbs()
  if (__DEV__) {
    seen = seen || new Map()
  }

  for (
    ;
    postFlushIndex <= index && postFlushIndex < activePostFlushCbs.length;
    postFlushIndex++
  ) {
    const cb = activePostFlushCbs[postFlushIndex]
    if (__DEV__ && checkRecursiveUpdates(seen!, cb)) {
      continue
    }
    if (cb.flags! & SchedulerJobFlags.ALLOW_RECURSE) {
      cb.flags! &= ~SchedulerJobFlags.QUEUED
    }
    if (!(cb.flags! & SchedulerJobFlags.DISPOSED)) cb()
    cb.flags! &= ~SchedulerJobFlags.QUEUED
  }
}

function flushJobs(seen?: CountMap) {
  if (!auto) return
  if (__DEV__) {
    seen = seen || new Map()
  }

  // conditional usage of checkRecursiveUpdate must be determined out of
  // try ... catch block since Rollup by default de-optimizes treeshaking
  // inside try-catch. This can leave all warning code unshaked. Although
  // they would get eventually shaken by a minifier like terser, some minifiers
  // would fail to do that (e.g. https://github.com/evanw/esbuild/issues/1610)
  const check = __DEV__
    ? (job: SchedulerJob) => checkRecursiveUpdates(seen!, job)
    : NOOP

  try {
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]
      if (job && !(job.flags! & SchedulerJobFlags.DISPOSED)) {
        if (__DEV__ && check(job)) {
          continue
        }
        if (job.flags! & SchedulerJobFlags.ALLOW_RECURSE) {
          job.flags! &= ~SchedulerJobFlags.QUEUED
        }
        callWithErrorHandling(
          job,
          job.i,
          job.i ? ErrorCodes.COMPONENT_UPDATE : ErrorCodes.SCHEDULER,
        )
        if (!(job.flags! & SchedulerJobFlags.ALLOW_RECURSE)) {
          job.flags! &= ~SchedulerJobFlags.QUEUED
        }
      }
    }
  } finally {
    // If there was an error we still need to clear the QUEUED flags
    for (; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]
      if (job) {
        job.flags! &= ~SchedulerJobFlags.QUEUED
      }
    }

    flushIndex = -1
    queue.length = 0

    flushPostFlushCbs(seen)

    endFlush()
    currentFlushPromise = null
    // If new jobs have been added to either queue, keep flushing
    if (queue.length || pendingPostFlushCbs.length) {
      flushJobs(seen)
    }
  }
}

function checkRecursiveUpdates(seen: CountMap, fn: SchedulerJob) {
  const count = seen.get(fn) || 0
  if (count > RECURSION_LIMIT) {
    const instance = fn.i
    const componentName = instance && getComponentName(instance.type)
    handleError(
      `Maximum recursive updates exceeded${
        componentName ? ` in component <${componentName}>` : ``
      }. ` +
        `This means you have a reactive effect that is mutating its own ` +
        `dependencies and thus recursively triggering itself. Possible sources ` +
        `include component template, render function, updated hook or ` +
        `watcher source function.`,
      null,
      ErrorCodes.APP_ERROR_HANDLER,
    )
    return true
  }
  seen.set(fn, count + 1)
  return false
}
