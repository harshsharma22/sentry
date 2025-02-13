import * as Sentry from '@sentry/react';
import memoize from 'lodash/memoize';
import {duration} from 'moment';

import type {Crumb} from 'sentry/types/breadcrumbs';
import {BreadcrumbType} from 'sentry/types/breadcrumbs';
import localStorageWrapper from 'sentry/utils/localStorage';
import extractDomNodes from 'sentry/utils/replays/extractDomNodes';
import hydrateBreadcrumbs, {
  replayInitBreadcrumb,
} from 'sentry/utils/replays/hydrateBreadcrumbs';
import hydrateErrors from 'sentry/utils/replays/hydrateErrors';
import hydrateFrames from 'sentry/utils/replays/hydrateFrames';
import {
  recordingEndFrame,
  recordingStartFrame,
} from 'sentry/utils/replays/hydrateRRWebRecordingFrames';
import hydrateSpans from 'sentry/utils/replays/hydrateSpans';
import {
  breadcrumbFactory,
  replayTimestamps,
  rrwebEventListFactory,
  spansFactory,
} from 'sentry/utils/replays/replayDataUtils';
import splitAttachmentsByType from 'sentry/utils/replays/splitAttachmentsByType';
import type {
  BreadcrumbFrame,
  ErrorFrame,
  OptionFrame,
  RecordingFrame,
  SpanFrame,
} from 'sentry/utils/replays/types';
import {BreadcrumbCategories, EventType} from 'sentry/utils/replays/types';
import type {
  MemorySpan,
  NetworkSpan,
  RecordingEvent,
  RecordingOptions,
  ReplayCrumb,
  ReplayError,
  ReplayRecord,
  ReplaySpan,
} from 'sentry/views/replays/types';

interface ReplayReaderParams {
  /**
   * Loaded segment data
   *
   * This is a mix of rrweb data, breadcrumbs and spans/transactions sorted by time
   * All three types are mixed together.
   */
  attachments: unknown[] | undefined;

  /**
   * Error objects related to this replay
   *
   * Error instances could be frontend, backend, or come from the error platform
   * like performance-errors or replay-errors
   */
  errors: ReplayError[] | undefined;

  /**
   * The root Replay event, created at the start of the browser session.
   */
  replayRecord: ReplayRecord | undefined;
}

type RequiredNotNull<T> = {
  [P in keyof T]: NonNullable<T[P]>;
};

export default class ReplayReader {
  static factory({attachments, errors, replayRecord}: ReplayReaderParams) {
    if (!attachments || !replayRecord || !errors) {
      return null;
    }

    try {
      return new ReplayReader({attachments, errors, replayRecord});
    } catch (err) {
      Sentry.captureException(err);

      // If something happens then we don't really know if it's the attachments
      // array or errors array to blame (it's probably attachments though).
      // Either way we can use the replayRecord to show some metadata, and then
      // put an error message below it.
      return new ReplayReader({
        attachments: [],
        errors: [],
        replayRecord,
      });
    }
  }

  private constructor({
    attachments,
    errors,
    replayRecord,
  }: RequiredNotNull<ReplayReaderParams>) {
    const {breadcrumbFrames, optionFrame, rrwebFrames, spanFrames} =
      hydrateFrames(attachments);

    if (localStorageWrapper.getItem('REPLAY-BACKEND-TIMESTAMPS') !== '1') {
      // TODO(replays): We should get correct timestamps from the backend instead
      // of having to fix them up here.
      const {startTimestampMs, endTimestampMs} = replayTimestamps(
        replayRecord,
        rrwebFrames,
        breadcrumbFrames,
        spanFrames
      );

      this.timestampDeltas = {
        startedAtDelta: startTimestampMs - replayRecord.started_at.getTime(),
        finishedAtDelta: endTimestampMs - replayRecord.finished_at.getTime(),
      };

      replayRecord.started_at = new Date(startTimestampMs);
      replayRecord.finished_at = new Date(endTimestampMs);
      replayRecord.duration = duration(
        replayRecord.finished_at.getTime() - replayRecord.started_at.getTime()
      );
    }

    // Hydrate the data we were given
    this.replayRecord = replayRecord;
    this._errors = hydrateErrors(replayRecord, errors);
    this._rrwebEvents = rrwebFrames;
    this._breadcrumbFrames = hydrateBreadcrumbs(replayRecord, breadcrumbFrames);
    this._spanFrames = hydrateSpans(replayRecord, spanFrames);
    this._optionFrame = optionFrame;

    // Insert extra records to satisfy minimum requirements for the UI
    this._breadcrumbFrames.push(replayInitBreadcrumb(replayRecord));
    this._rrwebEvents.unshift(recordingStartFrame(replayRecord));
    this._rrwebEvents.push(recordingEndFrame(replayRecord));

    /*********************/
    /** OLD STUFF BELOW **/
    /*********************/
    const {rawBreadcrumbs, rawRRWebEvents, rawNetworkSpans, rawMemorySpans} =
      splitAttachmentsByType(attachments);

    const spans = [...rawMemorySpans, ...rawNetworkSpans] as ReplaySpan[];

    // TODO(replays): We should get correct timestamps from the backend instead
    // of having to fix them up here.
    const {startTimestampMs, endTimestampMs} = replayTimestamps(
      replayRecord,
      rawRRWebEvents as RecordingEvent[],
      rawBreadcrumbs as ReplayCrumb[],
      spans
    );
    replayRecord.started_at = new Date(startTimestampMs);
    replayRecord.finished_at = new Date(endTimestampMs);
    replayRecord.duration = duration(
      replayRecord.finished_at.getTime() - replayRecord.started_at.getTime()
    );

    this.rawErrors = errors;

    this.sortedSpans = spansFactory(spans);
    this.breadcrumbs = breadcrumbFactory(
      replayRecord,
      errors,
      rawBreadcrumbs as ReplayCrumb[],
      this.sortedSpans
    );
    this.rrwebEvents = rrwebEventListFactory(
      replayRecord,
      rawRRWebEvents as RecordingEvent[]
    );

    this.replayRecord = replayRecord;
  }

  public timestampDeltas = {startedAtDelta: 0, finishedAtDelta: 0};

  private _breadcrumbFrames: BreadcrumbFrame[];
  private _errors: ErrorFrame[];
  private _optionFrame: undefined | OptionFrame;
  private _rrwebEvents: RecordingFrame[];
  private _spanFrames: SpanFrame[];

  private rawErrors: ReplayError[];
  private sortedSpans: ReplaySpan[];
  private replayRecord: ReplayRecord;
  private rrwebEvents: RecordingEvent[];
  private breadcrumbs: Crumb[];

  /**
   * @returns Duration of Replay (milliseonds)
   */
  getDurationMs = () => {
    return this.replayRecord.duration.asMilliseconds();
  };

  getReplay = () => {
    return this.replayRecord;
  };

  getRRWebFrames = () => this._rrwebEvents;

  getConsoleFrames = memoize(() =>
    this._breadcrumbFrames.filter(frame => frame.category === 'console')
  );

  getNetworkFrames = memoize(() =>
    this._spanFrames.filter(
      frame => frame.op.startsWith('navigation.') || frame.op.startsWith('resource.')
    )
  );

  getDOMFrames = memoize(() =>
    this._breadcrumbFrames.filter(frame => 'nodeId' in (frame.data ?? {}))
  );

  getMemoryFrames = memoize(() =>
    this._spanFrames.filter(frame => frame.op === 'memory')
  );

  _getChapters = () => [
    ...this._breadcrumbFrames.filter(
      frame =>
        ['replay.init', 'ui.click', 'replay.mutations', 'ui.slowClickDetected'].includes(
          frame.category
        ) || !BreadcrumbCategories.includes(frame.category)
    ),
    ...this._spanFrames.filter(frame =>
      ['navigation.navigate', 'navigation.reload', 'largest-contentful-paint'].includes(
        frame.op
      )
    ),
    ...this._errors,
  ];

  // Sort and memoize the chapters, so the Breadcrumbs UI Component has an easier time
  getSortedChapters = memoize(() =>
    this._getChapters().sort((a, b) => a.timestampMs - b.timestampMs)
  );

  getTimelineEvents = memoize(() => [
    ...this._breadcrumbFrames.filter(frame =>
      ['replay.init', 'ui.click'].includes(frame.category)
    ),
    ...this._spanFrames.filter(frame =>
      ['navigation.navigate', 'navigation.reload'].includes(frame.op)
    ),
    ...this._errors,
  ]);

  getSDKOptions = () => this._optionFrame;

  // TODO: move isNetworkDetailsSetup() up here? or extract it

  /*********************/
  /** OLD STUFF BELOW **/
  /*********************/
  getCrumbsWithRRWebNodes = memoize(() =>
    this.breadcrumbs.filter(
      crumb => crumb.data && typeof crumb.data === 'object' && 'nodeId' in crumb.data
    )
  );

  getUserActionCrumbs = memoize(() => {
    const USER_ACTIONS = [
      BreadcrumbType.ERROR,
      BreadcrumbType.INIT,
      BreadcrumbType.NAVIGATION,
      BreadcrumbType.UI,
      BreadcrumbType.USER,
    ];
    return this.breadcrumbs.filter(crumb => USER_ACTIONS.includes(crumb.type));
  });

  getConsoleCrumbs = memoize(() =>
    this.breadcrumbs.filter(crumb => crumb.category === 'console')
  );

  getRawErrors = memoize(() => this.rawErrors);

  getIssueCrumbs = memoize(() =>
    this.breadcrumbs.filter(crumb => crumb.category === 'issue')
  );

  getNonConsoleCrumbs = memoize(() =>
    this.breadcrumbs.filter(crumb => crumb.category !== 'console')
  );

  getNavCrumbs = memoize(() =>
    this.breadcrumbs.filter(crumb =>
      [BreadcrumbType.INIT, BreadcrumbType.NAVIGATION].includes(crumb.type)
    )
  );

  getNetworkSpans = memoize(() => this.sortedSpans.filter(isNetworkSpan));

  getMemorySpans = memoize(() => this.sortedSpans.filter(isMemorySpan));

  getDomNodes = memoize(() =>
    extractDomNodes({
      crumbs: this.getCrumbsWithRRWebNodes(),
      rrwebEvents: this.getRRWebFrames(),
      finishedAt: this.replayRecord.finished_at,
    })
  );

  sdkConfig = memoize(() => {
    const found = this.rrwebEvents.find(
      event => event.type === EventType.Custom && event.data.tag === 'options'
    ) as undefined | RecordingOptions;
    return found?.data?.payload;
  });

  isNetworkDetailsSetup = memoize(() => {
    const config = this.sdkConfig();
    if (config) {
      return this.sdkConfig()?.networkDetailHasUrls;
    }

    // Network data was added in JS SDK 7.50.0 while sdkConfig was added in v7.51.1
    // So even if we don't have the config object, we should still fallback and
    // look for spans with network data, as that means things are setup!
    return this.getNetworkSpans().some(
      span =>
        Object.keys(span.data.request?.headers || {}).length ||
        Object.keys(span.data.response?.headers || {}).length
    );
  });
}

const isMemorySpan = (span: ReplaySpan): span is MemorySpan => {
  return span.op === 'memory';
};

const isNetworkSpan = (span: ReplaySpan): span is NetworkSpan => {
  return span.op?.startsWith('navigation.') || span.op?.startsWith('resource.');
};
