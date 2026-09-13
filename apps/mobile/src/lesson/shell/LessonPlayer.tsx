import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
} from 'react-native';
import { lessonInterstitialCopy, reportReasons } from '@freelingo/core/presentation';
import { TraceControls } from '../exercises/TraceControls.js';
import { exerciseSpec, progressFraction } from '@freelingo/core/session';
import {
  BodyText,
  Button3D,
  Heading,
  LAYOUT,
  Panel,
  SPACE,
  UiProvider,
  useUiTheme,
} from '@freelingo/ui';
import type { LessonPlayerProps } from '../ports.js';
import { MatchControls } from '../exercises/MatchControls.js';
import { EXERCISE_RENDERERS } from '../exercises/registry.js';
import { BankControls, ChoiceControls, TypedControls } from '../exercises/controls.js';
import type { ExerciseControlsProps } from '../exercises/controls.js';

/** Controlled UI. Only the existing session engine grades, advances, checkpoints or exits. */
export function LessonPlayer(props: LessonPlayerProps) {
  return (
    <UiProvider
      theme={props.theme ?? 'dark'}
      highContrast={props.highContrast ?? false}
      boldText={props.boldText ?? false}
    >
      <PlayerContent {...props} />
    </UiProvider>
  );
}
function PlayerContent({
  state,
  challenge,
  exerciseId,
  onExposure,
  onEvent,
  media,
  onReport,
  onSnooze,
  onCredits,
  onExplain,
  onComplete,
}: LessonPlayerProps) {
  const { colors } = useUiTheme();
  const { height } = useWindowDimensions();
  const [composing, setComposing] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [mediaStatus, setMediaStatus] = useState('');
  const [recording, setRecording] = useState(false);
  const [inputLevel, setInputLevel] = useState(0);
  const permissionHandled = useRef<string | null>(null);
  const announcedObservation = useRef<string | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const requestEpoch = useRef(0);
  const requestKey = `${challenge?.itemId ?? ''}:${state.currentReplay?.item.id ?? state.core.queue[state.core.index]?.id ?? ''}`;
  const currentRequestKey = useRef(requestKey);
  currentRequestKey.current = requestKey;
  const banner = state.shellState.startsWith('banner.');
  const interactive =
    state.shellState === 'challenge.idle' || state.shellState === 'challenge.armed';
  const armed = state.shellState === 'challenge.armed' && !composing;
  const previousArmed = useRef(false);
  const previousCombo = useRef(0);
  const baseKind = challenge === null ? null : EXERCISE_RENDERERS[challenge.type].kind;
  const kind =
    baseKind === 'bank' && state.core.inputMode === 'keyboard'
      ? 'typed'
      : baseKind === 'typed' &&
          state.inputModeExplicit &&
          state.core.inputMode === 'bank' &&
          (challenge?.bank?.length ?? 0) > 0
        ? 'bank'
        : baseKind;
  const chatReading = kind === 'chat' && state.inFlight.partialState['chatRead'] !== true;
  const audioRequired = challenge !== null && exerciseSpec(challenge.type).requiresAudio;
  const currentSlot = state.currentReplay?.item ?? state.core.queue[state.core.index];
  const challengeVisible =
    challenge !== null &&
    (interactive || banner || state.shellState === 'grading' || state.shellState === 'quitDialog');
  const exposed = useRef(new Set<string>());
  useEffect(() => {
    if (
      !onExposure ||
      !exerciseId ||
      !challenge ||
      !currentSlot ||
      currentSlot.itemId !== challenge.itemId
    )
      return;
    const identity = {
      sessionId: state.sessionId,
      slotId: currentSlot.id,
      itemId: challenge.itemId,
      exerciseId,
    };
    const emit = (when: 'prompt' | 'wrong-feedback') => {
      const key = JSON.stringify([
        identity.sessionId,
        identity.slotId,
        identity.itemId,
        identity.exerciseId,
        when,
      ]);
      if (exposed.current.has(key)) return;
      exposed.current.add(key);
      onExposure({ ...identity, when });
    };
    if (challengeVisible && (!audioRequired || kind === 'chat') && challenge.prompt.trim())
      emit('prompt');
    if (state.shellState === 'banner.wrong' && challenge.acceptedAnswers[0]?.trim())
      emit('wrong-feedback');
  }, [
    onExposure,
    exerciseId,
    challenge,
    currentSlot,
    state.sessionId,
    state.shellState,
    challengeVisible,
    audioRequired,
    kind,
  ]);
  const retryNote =
    interactive && state.lastVerdict?.kind === 'noVerdict' ? state.lastVerdict.note : null;
  useEffect(() => {
    if (retryNote) media.announce(retryNote);
  }, [retryNote, state.lastVerdict, media]);
  const latestObservation = state.modality.observations.at(-1);
  const observation = latestObservation?.slotId === currentSlot?.id ? latestObservation : undefined;
  const replacementMissing =
    currentSlot !== undefined && state.modality.unavailableSlotIds.includes(currentSlot.id);
  const modalityMessage = replacementMissing
    ? 'This lesson needs a non-speaking or non-audio exercise from the course. Check the course download to continue.'
    : observation?.reviewKind === 'no_audio'
      ? state.modality.blockedFamilies.includes('speaking')
        ? 'We couldn’t hear you. We’ll use exercises without speaking for the rest of this lesson.'
        : 'We couldn’t hear you. Try again when you’re ready.'
      : observation?.reviewKind === 'transient'
        ? 'Microphone Access Problem. Try again or choose Can’t speak now.'
        : observation?.reviewKind === 'interrupted'
          ? 'Recording was interrupted. Try again when you’re ready.'
          : observation?.reviewKind === 'permission_denied'
            ? 'Microphone is off. We’ll use exercises without speaking.'
            : observation?.reviewKind === 'skipped'
              ? `${observation.family === 'speaking' ? 'Speaking' : 'Listening'} exercises are paused. They’ll turn back on in 1 hour.`
              : observation?.reviewKind === 'pronunciation_failure'
                ? 'Let’s try that pronunciation again. You can also choose Can’t speak now.'
                : observation?.reviewKind === 'speech_ungraded'
                  ? 'That attempt wasn’t graded. Try again when you’re ready.'
                  : '';
  useEffect(() => {
    if (
      observation !== undefined &&
      observation.id !== announcedObservation.current &&
      modalityMessage
    ) {
      announcedObservation.current = observation.id;
      media.announce(modalityMessage);
    }
  }, [observation, modalityMessage, media]);
  useEffect(() => {
    if (
      interactive &&
      baseKind === 'speak' &&
      challenge !== null &&
      currentSlot !== undefined &&
      media.capabilities.microphonePermission === 'denied' &&
      permissionHandled.current !== requestKey
    ) {
      permissionHandled.current = requestKey;
      onEvent({
        type: 'speechError',
        eventId: `permission:${requestKey}`,
        slotId: currentSlot.id,
        itemId: challenge.itemId,
        error: 'permission-denied',
      });
    }
  }, [
    interactive,
    baseKind,
    challenge,
    currentSlot,
    media.capabilities.microphonePermission,
    requestKey,
    onEvent,
  ]);
  const skipModality = (family: 'speaking' | 'listening') => {
    if (!interactive || challenge === null || currentSlot === undefined) return;
    requestEpoch.current++;
    stop.current?.();
    setRecording(false);
    onEvent({
      type: 'modalitySkip',
      eventId: `skip:${requestKey}:${state.modality.observations.length}`,
      slotId: currentSlot.id,
      itemId: challenge.itemId,
      family,
    });
  };

  const currentInput = useRef(state.inFlight);
  currentInput.current = state.inFlight;
  useEffect(() => {
    if (state.shellState === 'loading' && challenge !== null) onEvent({ type: 'rendered' });
  }, [state.shellState, challenge, onEvent]);
  useEffect(() => {
    if (armed && !previousArmed.current) media.announce('Check enabled');
    previousArmed.current = armed;
  }, [armed, media]);
  useEffect(() => {
    if (state.core.combo !== previousCombo.current && state.core.combo >= 2)
      media.announce(`${state.core.combo} in a row`);
    previousCombo.current = state.core.combo;
  }, [state.core.combo, media]);
  useEffect(() => {
    setMediaStatus('');
    setRecording(false);
    setInputLevel(0);
    setComposing(false);
    return () => {
      requestEpoch.current++;
      stop.current?.();
      stop.current = null;
    };
  }, [requestKey]);
  const check = () => {
    if (armed) onEvent({ type: 'check' });
  };
  const input: ExerciseControlsProps['onInput'] = (text, caret, partialState, gradeable) =>
    onEvent({ type: 'input', text, caret, partialState, gradeable });
  const controls: ExerciseControlsProps | null =
    challenge === null
      ? null
      : {
          challenge,
          input: state.inFlight,
          disabled: !interactive,
          onInput: input,
          onComposition: setComposing,
          onSubmit: check,
          announce: media.announce,
        };
  const play = (slow: boolean) => {
    if (challenge === null) return;
    if (challenge.language.split('-')[0] === 'ja' && challenge.audioText === undefined) {
      setMediaStatus('Audio reading is unavailable. Return to the path to reload this lesson.');
      return;
    }
    requestEpoch.current++;
    stop.current?.();
    const epoch = requestEpoch.current,
      key = requestKey;
    let settled = false;
    const current = () =>
      !settled && epoch === requestEpoch.current && key === currentRequestKey.current;
    setMediaStatus('Playing audio');
    const ref = slow ? (challenge.slowAudioRef ?? challenge.audioRef) : challenge.audioRef;
    stop.current = media.play(
      {
        itemId: challenge.itemId,
        ...(ref === undefined ? {} : { assetRef: ref }),
        text: challenge.audioText ?? challenge.prompt,
        locale: challenge.language,
        slow,
        ...(slow && challenge.slowAudioRef !== undefined ? { assetIsSlow: true } : {}),
      },
      {
        onComplete: () => {
          if (!current()) return;
          settled = true;
          setMediaStatus('Audio complete');
          onEvent({ type: 'audioCompleted' });
          const value = currentInput.current;
          input(value.text, value.caret, value.partialState, value.text.trim().length > 0);
        },
        onInterrupted: () => {
          if (!current()) return;
          settled = true;
          setMediaStatus('Audio paused. Play it again when you’re ready.');
          onEvent({ type: 'audioInterrupted' });
        },
        onError: (error) => {
          if (!current()) return;
          settled = true;
          setMediaStatus(
            error === 'permission-denied'
              ? 'Audio access is unavailable. Open Settings to review it.'
              : 'Audio could not play. Try the replay control.',
          );
          onEvent({ type: 'audioInterrupted' });
        },
      },
    );
  };
  const speak = () => {
    if (
      challenge === null ||
      currentSlot === undefined ||
      replacementMissing ||
      !interactive ||
      !media.capabilities.canRecognize ||
      media.capabilities.announcementInFlight ||
      media.capabilities.microphonePermission !== 'granted'
    )
      return;
    if (recording) {
      requestEpoch.current++;
      stop.current?.();
      setRecording(false);
      return;
    }
    requestEpoch.current++;
    stop.current?.();
    const epoch = requestEpoch.current,
      key = requestKey;
    let settled = false;
    const current = () =>
      !settled && epoch === requestEpoch.current && key === currentRequestKey.current;
    const observationKey = {
      eventId: `asr:${requestKey}:${state.modality.observations.length}`,
      slotId: currentSlot.id,
      itemId: challenge.itemId,
    };
    setRecording(true);
    setMediaStatus('Listening…');
    stop.current = media.recognize(
      { itemId: challenge.itemId, locale: challenge.language },
      {
        onResult: (result) => {
          if (!current()) return;
          settled = true;
          setRecording(false);
          setInputLevel(
            Math.max(0, Math.min(1, Number.isFinite(result.amplitude) ? result.amplitude : 0)),
          );
          setMediaStatus('');
          onEvent({
            type: 'speechResult',
            ...observationKey,
            transcript: result.transcript,
            amplitude: result.amplitude,
            ...(result.segments === undefined ? {} : { segments: result.segments }),
          });
        },
        onError: (error) => {
          if (!current()) return;
          settled = true;
          setRecording(false);
          setMediaStatus('');
          onEvent({
            type: 'speechError',
            ...observationKey,
            error:
              error === 'permission-denied'
                ? 'permission-denied'
                : error === 'interrupted'
                  ? 'interrupted'
                  : 'transient',
          });
        },
      },
    );
  };
  const close = () => {
    if (!composing) onEvent({ type: 'exit', route: 'closeButton' });
  };
  const verdictHeadline =
    state.lastVerdict?.note ?? (state.shellState === 'banner.wrong' ? 'Incorrect' : 'Correct!');
  const progressText = `${state.progress.numerator} of ${state.progress.denominator}${state.core.combo >= 2 ? `, ${state.core.combo} in a row` : ''}`;
  return (
    <View style={{ flex: 1, backgroundColor: colors.snow }} testID="lesson-player">
      <View
        style={{ width: '100%', maxWidth: LAYOUT.contentMaxWidthPx, alignSelf: 'center', flex: 1 }}
      >
        <View
          style={{
            height: LAYOUT.lessonHeaderHeightPx,
            flexDirection: 'row',
            alignItems: 'center',
            gap: SPACE.md,
            paddingHorizontal: SPACE.md,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close lesson"
            onPress={close}
            style={{ padding: SPACE.xs }}
          >
            <BodyText style={{ color: colors.hare, fontSize: 32 }}>×</BodyText>
          </Pressable>
          <View
            accessibilityRole="progressbar"
            accessibilityLabel="Lesson progress"
            accessibilityValue={{
              min: 0,
              max: state.progress.denominator,
              now: state.progress.numerator,
              text: progressText,
            }}
            style={{
              height: LAYOUT.progressHeightPx,
              borderRadius: LAYOUT.progressRadiusPx,
              flex: 1,
              minWidth: 80,
              backgroundColor: colors.swan,
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                height: '100%',
                width: `${progressFraction(state.progress) * 100}%`,
                backgroundColor: state.core.combo >= 6 ? colors.bee : colors.owl,
                borderRadius: LAYOUT.progressRadiusPx,
              }}
            />
          </View>
          <BodyText style={{ color: colors.cardinal, fontSize: 27 }}>∞</BodyText>
        </View>
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, padding: SPACE.md, gap: SPACE.lg }}
          keyboardShouldPersistTaps="handled"
        >
          {state.core.combo >= 2 ? (
            <BodyText style={{ color: state.core.combo >= 6 ? colors.bee : colors.owl }}>
              {state.core.combo} IN A ROW
            </BodyText>
          ) : null}
          {state.core.hearts.kind === 'pips' ? (
            <BodyText>
              {state.core.hearts.remaining} of {state.core.hearts.total} mistakes remaining ●
            </BodyText>
          ) : null}
          {state.shellState === 'loading' ? (
            <>
              <ActivityIndicator color={colors.macaw} />
              <Heading>Starting…</Heading>
            </>
          ) : null}
          {state.shellState === 'complete' ? <Heading>Lesson complete!</Heading> : null}
          {state.shellState === 'interstitial' ? (
            <Panel>
              <Heading>You’re making progress!</Heading>
              <BodyText>
                {lessonInterstitialCopy(state.pendingInterstitialKeys[0] ?? '', state.core.combo)}
              </BodyText>
            </Panel>
          ) : null}
          {state.shellState === 'mistakeReview' ? (
            <Panel>
              <Heading>Let’s review the exercises you missed!</Heading>
            </Panel>
          ) : null}
          {state.shellState === 'tips' ? (
            <Panel>
              <Heading>Tip</Heading>
              <BodyText>
                {challenge?.tip ?? 'Read the prompt, then choose or type your answer.'}
              </BodyText>
            </Panel>
          ) : null}
          {state.shellState === 'outOfHearts' ? (
            <Panel>
              <Heading>Try again with fewer mistakes</Heading>
              <BodyText>
                Your completed answers are saved. You can return to the path and try again.
              </BodyText>
            </Panel>
          ) : null}
          {challenge !== null && challengeVisible ? (
            <>
              {state.core.hardMode || challenge.hard ? (
                <BodyText style={{ color: colors.bee }}>HARD EXERCISE</BodyText>
              ) : null}
              {state.currentReplay !== null ? (
                <BodyText style={{ color: colors.bee }}>PREVIOUS MISTAKE</BodyText>
              ) : null}
              {challenge.introduction !== undefined ? (
                <BodyText style={{ color: colors.macaw }}>
                  NEW {challenge.introduction.toUpperCase()}
                </BodyText>
              ) : null}
              <Heading>{challenge.instruction}</Heading>
              {!audioRequired || kind === 'chat' ? (
                <Panel>
                  <BodyText language={challenge.promptLanguage ?? challenge.language}>
                    {challenge.prompt}
                  </BodyText>
                </Panel>
              ) : null}
              {audioRequired || challenge.audioRef !== undefined ? (
                <View style={{ flexDirection: 'row', gap: SPACE.md }}>
                  <Button3D label="Play audio" tone="macaw" compact onPress={() => play(false)} />
                  <Button3D label="Play slowly" tone="neutral" compact onPress={() => play(true)} />
                </View>
              ) : null}
              {mediaStatus ? <BodyText>{mediaStatus}</BodyText> : null}
              {modalityMessage ? <BodyText>{modalityMessage}</BodyText> : null}
              {retryNote ? <BodyText>{retryNote}</BodyText> : null}
              {replacementMissing ? (
                <Button3D
                  label="Check course download"
                  tone="neutral"
                  onPress={() => media.remediate('no-content')}
                />
              ) : null}
              {controls !== null && kind === 'bank' ? <BankControls {...controls} /> : null}
              {controls !== null && kind === 'match' ? (
                <MatchControls
                  {...controls}
                  seed={
                    state.core.optionSeeds[
                      state.currentReplay?.item.id ?? state.core.queue[state.core.index]?.id ?? ''
                    ] ?? 0
                  }
                  slotId={
                    state.currentReplay?.item.id ?? state.core.queue[state.core.index]?.id ?? ''
                  }
                  onEvent={onEvent}
                />
              ) : null}
              {controls !== null &&
              (kind === 'choice' || kind === 'picture' || (kind === 'chat' && !chatReading)) ? (
                <>
                  {kind === 'chat' ? (
                    <Panel>
                      <BodyText language={challenge.language}>
                        {state.inFlight.text || '…'}
                      </BodyText>
                    </Panel>
                  ) : null}
                  <ChoiceControls {...controls} />
                </>
              ) : null}
              {controls !== null && kind === 'typed' ? <TypedControls {...controls} /> : null}
              {kind === 'speak' ? (
                <>
                  <Button3D
                    label={
                      recording
                        ? 'Stop recording'
                        : observation?.reviewKind === 'transient'
                          ? 'Retry recording'
                          : 'Tap to speak'
                    }
                    tone="macaw"
                    disabled={
                      !interactive ||
                      replacementMissing ||
                      media.capabilities.announcementInFlight ||
                      !media.capabilities.canRecognize
                    }
                    onPress={speak}
                  />
                  <Button3D
                    label="Can’t speak now"
                    tone="neutral"
                    onPress={() => skipModality('speaking')}
                  />
                  {observation?.reviewKind === 'no_audio' ? (
                    <View
                      accessibilityRole="progressbar"
                      accessibilityLabel="Microphone input level"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(inputLevel * 100)}
                    >
                      <BodyText>Input level: {Math.round(inputLevel * 100)}%</BodyText>
                    </View>
                  ) : null}
                  {!media.capabilities.canRecognize ? (
                    <Button3D
                      label="Review speaking settings"
                      tone="neutral"
                      onPress={() =>
                        media.remediate(
                          media.capabilities.microphonePermission === 'denied'
                            ? 'mic-denied'
                            : 'no-recogniser-for-locale',
                        )
                      }
                    />
                  ) : null}
                </>
              ) : null}
              {kind === 'introduce' ? (
                <BodyText language={challenge.language}>{challenge.acceptedAnswers[0]}</BodyText>
              ) : null}
              {controls !== null && kind === 'trace' ? (
                <TraceControls {...controls} onEvent={onEvent} />
              ) : null}
              {audioRequired ? (
                <Button3D
                  label="Can’t listen now"
                  tone="neutral"
                  onPress={() => skipModality('listening')}
                />
              ) : null}
              {(kind === 'bank' || kind === 'typed') && (challenge.bank?.length ?? 0) > 0 ? (
                <Button3D
                  label={kind === 'bank' ? 'Use keyboard' : 'Use word bank'}
                  tone="neutral"
                  onPress={() => {
                    if (!composing)
                      onEvent({
                        type: 'setInputMode',
                        mode: kind === 'bank' ? 'keyboard' : 'bank',
                      });
                  }}
                />
              ) : null}
            </>
          ) : null}
        </ScrollView>
        <View
          style={{
            padding: SPACE.md,
            borderTopWidth: 2,
            borderColor: colors.swan,
            gap: SPACE.sm,
            backgroundColor: banner ? colors.polar : colors.snow,
            maxHeight: height * LAYOUT.feedbackMaxHeightFraction,
          }}
        >
          {banner ? (
            <>
              <ScrollView>
                <Heading
                  style={{
                    color: state.shellState === 'banner.wrong' ? colors.cardinal : colors.owl,
                  }}
                >
                  {verdictHeadline}
                </Heading>
                {state.shellState === 'banner.wrong' ? (
                  <>
                    <BodyText>Correct solution:</BodyText>
                    <BodyText language={challenge?.language}>
                      {challenge?.acceptedAnswers[0]}
                    </BodyText>
                  </>
                ) : null}
                <View style={{ flexDirection: 'row', gap: SPACE.md }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Snooze exercise"
                    disabled={onSnooze === undefined}
                    onPress={() => {
                      if (challenge !== null) onSnooze?.(challenge.itemId);
                    }}
                  >
                    <BodyText>Snooze</BodyText>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Report exercise"
                    onPress={() => setReportOpen(true)}
                  >
                    <BodyText>Report</BodyText>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Explain my answer"
                    disabled={state.inFlight.text.trim() === ''}
                    onPress={() => {
                      if (challenge !== null && state.inFlight.text.trim() !== '')
                        onExplain({
                          itemId: challenge.itemId,
                          submittedAnswer: state.inFlight.text,
                        });
                    }}
                  >
                    <BodyText>Explain my answer</BodyText>
                  </Pressable>
                </View>
              </ScrollView>
              <Button3D
                label="Continue"
                tone={state.shellState === 'banner.wrong' ? 'danger' : 'primary'}
                onPress={() => onEvent({ type: 'continue' })}
              />
            </>
          ) : state.shellState === 'complete' ? (
            <Button3D label="Continue" onPress={onComplete} />
          ) : state.shellState === 'tips' ? (
            <Button3D label="Continue" onPress={() => onEvent({ type: 'tipsContinue' })} />
          ) : state.shellState === 'interstitial' || state.shellState === 'mistakeReview' ? (
            <Button3D label="Continue" onPress={() => onEvent({ type: 'continue' })} />
          ) : state.shellState === 'outOfHearts' ? (
            <Button3D
              label="Return to path"
              onPress={() => onEvent({ type: 'endSession', route: 'closeButton' })}
            />
          ) : chatReading ? (
            <Button3D
              label="Next"
              tone="macaw"
              onPress={() =>
                input('', 0, { ...state.inFlight.partialState, chatRead: true }, false)
              }
            />
          ) : kind === 'introduce' ? (
            <Button3D
              label="Continue"
              onPress={() => {
                const answer = challenge?.acceptedAnswers[0] ?? '';
                input(answer, answer.length, state.inFlight.partialState, true);
                onEvent({ type: 'check' });
              }}
            />
          ) : kind === 'trace' ? (
            <BodyText>Follow the numbered strokes</BodyText>
          ) : kind === 'match' ? (
            <BodyText>Match all pairs</BodyText>
          ) : (
            <Button3D
              label={state.shellState === 'grading' ? 'Checking…' : 'Check'}
              disabled={!armed}
              accessibilityHint={
                armed
                  ? 'Submit your answer'
                  : composing
                    ? 'Finish composing your text first'
                    : audioRequired && !state.inFlight.audioHeardToEnd
                      ? 'Listen to the full audio first'
                      : 'Choose or enter an answer first'
              }
              onPress={check}
            />
          )}
        </View>
      </View>
      <Modal
        visible={state.shellState === 'quitDialog'}
        transparent
        animationType="none"
        onRequestClose={() => onEvent({ type: 'keepLearning' })}
      >
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            padding: SPACE.lg,
            backgroundColor: colors.snow,
          }}
        >
          <Panel>
            <Heading>End session?</Heading>
            <BodyText>
              Your completed answers will be saved. Keep learning to finish this lesson.
            </BodyText>
            <Button3D label="Keep learning" onPress={() => onEvent({ type: 'keepLearning' })} />
            <Button3D
              label="End session"
              tone="danger"
              onPress={() => onEvent({ type: 'endSession', route: 'closeButton' })}
            />
          </Panel>
        </View>
      </Modal>
      <Modal
        visible={reportOpen}
        transparent
        animationType="none"
        onRequestClose={() => setReportOpen(false)}
      >
        <View style={{ flex: 1, padding: SPACE.lg, backgroundColor: colors.snow }}>
          <Heading>Choose a reason for the report…</Heading>
          <ScrollView>
            {(challenge === null ? [] : reportReasons(challenge)).map((reason) => (
              <Button3D
                key={reason}
                label={reason}
                tone="neutral"
                onPress={() => {
                  if (challenge !== null) onReport(challenge.itemId, reason);
                  setReportOpen(false);
                }}
              />
            ))}
          </ScrollView>
          <Button3D
            label="Source and credits"
            tone="neutral"
            disabled={onCredits === undefined}
            onPress={() => {
              if (challenge !== null) onCredits?.(challenge.itemId);
            }}
          />
          <Button3D label="Cancel" tone="neutral" onPress={() => setReportOpen(false)} />
        </View>
      </Modal>
    </View>
  );
}
