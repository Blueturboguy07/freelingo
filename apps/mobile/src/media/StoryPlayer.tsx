import { useEffect, useRef, useState } from 'react';
import { Image, ScrollView, Text, View } from 'react-native';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as Speech from 'expo-speech';
import {
  advanceStory,
  answerStory,
  currentStoryChallenge,
  karaokeRange,
  MEDIA_POSITION_INTERVAL_MS,
  reviewSkippedStory,
  setStoryForeground,
  startStory,
  STORY_COPY,
  storyCompletion,
  storyParts,
  storyProgress,
} from '@freelingo/core/stories';
import type {
  NarrativeAnswer,
  ResolvedStoryAudio,
  StoryState,
  StoryText,
} from '@freelingo/core/stories';
import type { StoryPlayerProps } from './contracts';
import { ChallengeCard, MediaButton, NarrativeText, Progress, useForeground } from './common';
import { styles } from './style';
export function StoryPlayer(props: StoryPlayerProps) {
  const { story } = props;
  const [state, setState] = useState(props.initialState);
  const current = useRef(state);
  const latest = useRef(props);
  latest.current = props;
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [playingLine, setPlayingLine] = useState<string | null>(null);
  const [playingAudio, setPlayingAudio] = useState<ResolvedStoryAudio>({
    kind: 'unavailable',
    reason: 'No active audio.',
  });
  const scrolling = useRef(false);
  const scroll = useRef<ScrollView>(null);
  const foreground = useForeground(props.foreground);
  const player = useAudioPlayer(null, { updateInterval: MEDIA_POSITION_INTERVAL_MS });
  const status = useAudioPlayerStatus(player);
  const update = (next: StoryState) => {
    current.current = next;
    setState(next);
    void Promise.resolve(latest.current.onSave(next)).catch(() =>
      setError('Your place could not be saved. Try again.'),
    );
  };
  const advance = () => {
    setHint(null);
    update(advanceStory(story, current.current));
  };
  useEffect(() => {
    update(setStoryForeground(current.current, foreground));
  }, [foreground]);
  useEffect(
    () => () => {
      player.pause();
      player.setActiveForLockScreen(false);
      void Speech.stop();
      void latest.current.onSave(current.current);
    },
    [player],
  );
  const playLine = async (id: string, content: StoryText) => {
    const audio = props.audioByElementId[id];
    if (!audio || audio.kind === 'unavailable') return;
    try {
      await Speech.stop();
      player.pause();
      setPlayingLine(id);
      setPlayingAudio(audio);
      await setAudioModeAsync({
        interruptionMode: 'mixWithOthers',
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        allowsRecording: false,
      });
      if (audio.kind === 'baked') {
        player.replace(audio.uri);
        player.play();
      } else
        Speech.speak(content.text, {
          language: story.language,
          voice: audio.voiceId,
          onDone: () => {
            setPlayingLine(null);
            if (!current.current.foreground) advance();
          },
          onError: () => setError('This line’s audio is unavailable.'),
        });
    } catch {
      setError('This line’s audio is unavailable.');
    }
  };
  const parts = storyParts(story, state.mode);
  const question = currentStoryChallenge(story, state);
  const attempt = state.answers.find((answer) => answer.questionId === question?.id);
  useEffect(() => {
    if (!scrolling.current) scroll.current?.scrollToEnd({ animated: false });
    if (current.current.mode === 'listening') return;
    const line = parts[current.current.partIndex]?.elements.find(
      (element) => element.type === 'LINE' || element.type === 'HEADER',
    );
    if (line && (line.type === 'LINE' || line.type === 'HEADER'))
      void playLine(line.id, line.content);
  }, [state.partIndex]);
  useEffect(() => {
    if (current.current.mode === 'listening') {
      let next = current.current;
      const timeline = story.stitchedAudio;
      if (!timeline) return;
      while (next.partIndex < parts.length) {
        const timing = timeline.parts.find((part) => part.partId === parts[next.partIndex]?.id);
        if (!status.didJustFinish && timing && status.currentTime * 1000 < timing.endMs) break;
        next = advanceStory(story, next);
      }
      if (next.partIndex !== current.current.partIndex) update(next);
    } else if (status.didJustFinish && !current.current.foreground) advance();
  }, [status.currentTime, status.didJustFinish]);
  const answer = (value: NarrativeAnswer) => {
    const next = answerStory(story, current.current, value);
    if (next.answers.length > current.current.answers.length)
      props.onAttempt(next.answers.at(-1)!, next);
    update(next);
  };
  const listen = async () => {
    if (!story.stitchedAudio) return;
    update(startStory(story, 'listening', state.runId));
    await Speech.stop();
    await setAudioModeAsync({
      interruptionMode: 'doNotMix',
      playsInSilentMode: true,
      shouldPlayInBackground: true,
    });
    player.replace(story.stitchedAudio.uri);
    player.setActiveForLockScreen(true, { title: story.title });
    player.play();
  };
  const complete = async () => {
    const completion = storyCompletion(story, current.current, true);
    if (!completion.canCommit || finished) return;
    setFinished(true);
    try {
      await props.onComplete(completion, current.current);
    } catch {
      setFinished(false);
      setError('Could not save this story. Try again.');
    }
  };
  const ended = state.partIndex >= parts.length;
  return (
    <View style={styles.screen} testID="story-player">
      <View style={styles.top}>
        <MediaButton
          label="Close story"
          secondary
          onPress={() => {
            player.pause();
            props.onClose();
          }}
        >
          ×
        </MediaButton>
        <Progress value={storyProgress(story, state)} label="Story progress" />
      </View>
      <ScrollView
        ref={scroll}
        style={styles.scroll}
        contentContainerStyle={styles.transcript}
        onScrollBeginDrag={() => {
          scrolling.current = true;
        }}
        onMomentumScrollEnd={() => {
          scrolling.current = false;
        }}
      >
        {parts
          .slice(0, state.partIndex + 1)
          .flatMap((part) => part.elements)
          .map((element) => {
            if (element.type === 'ERROR')
              return (
                <Text
                  key={element.id}
                  accessibilityRole="alert"
                  style={[styles.text, styles.error]}
                >
                  {element.message}
                </Text>
              );
            if (element.type !== 'LINE' && element.type !== 'HEADER') return null;
            const content = element.content;
            const audio = props.audioByElementId[element.id] ?? {
              kind: 'unavailable' as const,
              reason: 'Audio is not available for this line.',
            };
            const hidden =
              element.type === 'LINE' && question?.lineIndex === element.lineIndex && !attempt
                ? (element.hidden ?? [])
                : [];
            return (
              <View
                key={element.id}
                style={element.type === 'HEADER' ? styles.center : styles.column}
              >
                {element.type === 'HEADER' && (
                  <>
                    <Image
                      source={{
                        uri: story.covers[state.mode === 'legendary' ? 'gilded' : 'active'],
                      }}
                      style={styles.cover}
                      accessibilityLabel={story.title}
                    />
                    <Text style={styles.title}>{`Story: ${story.title}`}</Text>
                  </>
                )}
                {element.type === 'LINE' && element.characterId && (
                  <Text style={styles.label}>
                    {props.characterNames[element.characterId] ?? element.characterId}
                  </Text>
                )}
                <NarrativeText
                  content={content}
                  mode={question?.type === 'POINT_TO_PHRASE' && !attempt ? 'legendary' : state.mode}
                  hidden={hidden}
                  selectable={
                    question?.type === 'POINT_TO_PHRASE' &&
                    question.lineIndex === element.lineIndex &&
                    !attempt
                      ? question.ranges
                      : []
                  }
                  onSelect={(rangeId) => answer({ kind: 'range', rangeId })}
                  rubyEnabled={props.rubyEnabled ?? true}
                  highlight={
                    playingLine === element.id && status.playing
                      ? karaokeRange(content, playingAudio, status.currentTime * 1000)
                      : null
                  }
                  onHint={setHint}
                />
                <MediaButton
                  label={`Play ${content.text}`}
                  secondary
                  disabled={audio.kind === 'unavailable'}
                  onPress={() => void playLine(element.id, content)}
                >
                  {'▶'}
                </MediaButton>
                {audio.kind === 'unavailable' && (
                  <Text style={[styles.text, styles.muted]}>{audio.reason}</Text>
                )}
              </View>
            );
          })}
        {hint && (
          <View style={styles.card}>
            <Text style={styles.text}>{hint}</Text>
            <MediaButton label="Close hint" secondary onPress={() => setHint(null)} />
          </View>
        )}
        {question && state.mode !== 'listening' && (
          <ChallengeCard
            key={question.id}
            question={question}
            answered={!!attempt}
            onAnswer={answer}
          />
        )}
        {attempt && (
          <Text accessibilityRole="alert" style={styles.text}>
            {attempt.correct ? 'Correct!' : 'Not quite. Keep going.'}
          </Text>
        )}
        {error && (
          <Text accessibilityRole="alert" style={[styles.text, styles.error]}>
            {error}
          </Text>
        )}
        {ended && <Text style={styles.title}>{STORY_COPY.complete}</Text>}
      </ScrollView>
      {state.partIndex === 0 &&
        state.mode !== 'listening' &&
        story.bakedAudioComplete &&
        story.stitchedAudio && (
          <MediaButton
            label="Listen to story"
            secondary
            onPress={() => void listen().catch(() => setError('Listening audio could not start.'))}
          />
        )}
      {state.mode === 'listening' && !ended && (
        <MediaButton
          label={status.playing ? 'Pause story' : 'Play story'}
          onPress={() => (status.playing ? player.pause() : player.play())}
        />
      )}
      {ended && state.skippedIds.length > 0 && foreground && (
        <MediaButton
          label="Answer skipped questions"
          secondary
          onPress={() => update(reviewSkippedStory(story, { ...state, mode: 'normal' }))}
        />
      )}
      {ended ? (
        <MediaButton
          label={finished ? 'Saved' : 'Finish story'}
          disabled={finished || !foreground}
          onPress={() => void complete()}
        />
      ) : (
        state.mode !== 'listening' && (
          <MediaButton label="Continue" disabled={!!question && !attempt} onPress={advance} />
        )
      )}
    </View>
  );
}
