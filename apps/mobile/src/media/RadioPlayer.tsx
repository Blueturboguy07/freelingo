import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import {
  answerRadio,
  completeRadio,
  moveRadio,
  RADIO_REWIND_MS,
  selectionReady,
  setRadioForeground,
  toggleSelection,
} from '@freelingo/core/radio';
import type { RadioQuestion, RadioState } from '@freelingo/core/radio';
import { MEDIA_POSITION_INTERVAL_MS } from '@freelingo/core/stories';
import type { NarrativeAnswer } from '@freelingo/core/stories';
import type { RadioPlayerHandle, RadioPlayerProps } from './contracts';
import { ChallengeCard, MediaButton, Progress, useForeground } from './common';
import { styles } from './style';

function RadioQuestionCard({
  question,
  onAnswer,
}: {
  question: RadioQuestion;
  onAnswer: (answer: NarrativeAnswer) => void;
}) {
  const [selected, setSelected] = useState<readonly string[]>([]);
  if (question.kind === 'listenSelect')
    return (
      <View style={styles.card}>
        <Text
          style={styles.text}
        >{`Select ${question.count} ${question.count === 1 ? 'word' : 'words'} you hear`}</Text>
        <View style={styles.row}>
          {question.tiles.map((tile) => (
            <MediaButton
              key={tile.id}
              label={tile.text}
              secondary={!selected.includes(tile.id)}
              onPress={() => setSelected(toggleSelection(selected, tile.id))}
            />
          ))}
        </View>
        <MediaButton
          label="Check words"
          disabled={!selectionReady(question.count, selected)}
          onPress={() => onAnswer({ kind: 'tiles', tileIds: selected })}
        />
      </View>
    );
  if (question.kind === 'comprehension')
    return (
      <ChallengeCard
        question={{ ...question, type: 'MULTIPLE_CHOICE', lineIndex: 0 }}
        answered={false}
        onAnswer={onAnswer}
      />
    );
  return (
    <ChallengeCard
      question={{ ...question, type: 'MATCH', lineIndex: 0 }}
      answered={false}
      onAnswer={onAnswer}
    />
  );
}
export const RadioPlayer = forwardRef<RadioPlayerHandle, RadioPlayerProps>(
  function RadioPlayer(props, ref) {
    const { episode } = props;
    const [state, setState] = useState(props.initialState);
    const current = useRef(state);
    const latest = useRef(props);
    latest.current = props;
    const [transcript, showTranscript] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [finished, setFinished] = useState(false);
    const foreground = useForeground(props.foreground);
    const player = useAudioPlayer(props.audioAvailable ? episode.audio.uri : null, {
      updateInterval: MEDIA_POSITION_INTERVAL_MS,
    });
    const status = useAudioPlayerStatus(player);
    const lastSavedSecond = useRef(-1);
    const restored = useRef(false);
    const save = (next: RadioState) => {
      void Promise.resolve(latest.current.onSave(next)).catch(() => {
        player.pause();
        setError('Your place could not be saved. Try again.');
      });
    };
    const update = (next: RadioState, persist = true) => {
      current.current = next;
      setState(next);
      if (persist) save(next);
    };
    useImperativeHandle(
      ref,
      () => ({
        async interruptForGradedSession() {
          player.pause();
          const next = { ...current.current, playing: false };
          current.current = next;
          setState(next);
          try {
            await latest.current.onSave(next);
          } finally {
            player.setActiveForLockScreen(false);
          }
        },
      }),
      [player],
    );
    useEffect(
      () => () => {
        player.pause();
        player.setActiveForLockScreen(false);
        void latest.current.onSave({ ...current.current, playing: false });
      },
      [player],
    );
    useEffect(() => {
      const next = setRadioForeground(current.current, foreground);
      update(next);
      if (next.activeQuestionId) player.pause();
      else if (next.playing) player.play();
    }, [foreground]);
    useEffect(() => {
      if (!status.isLoaded || restored.current || !props.audioAvailable) return;
      let cancelled = false;
      void player
        .seekTo(current.current.positionMs / 1000)
        .then(() => {
          if (!cancelled) restored.current = true;
        })
        .catch(() => setError('Could not restore this episode. Try again.'));
      return () => {
        cancelled = true;
      };
    }, [status.isLoaded, player, props.audioAvailable]);
    useEffect(() => {
      if (!restored.current) return;
      const next = moveRadio(episode, current.current, status.currentTime * 1000);
      if (next.activeQuestionId && !current.current.activeQuestionId) {
        player.pause();
        void player.seekTo(next.positionMs / 1000);
      }
      const second = Math.floor(next.positionMs / 1000);
      update(
        { ...next, playing: next.activeQuestionId ? false : status.playing },
        second !== lastSavedSecond.current ||
          next.activeQuestionId !== current.current.activeQuestionId,
      );
      lastSavedSecond.current = second;
    }, [status.currentTime, status.playing, episode]);
    const play = async () => {
      try {
        await setAudioModeAsync({
          interruptionMode: 'doNotMix',
          playsInSilentMode: true,
          shouldPlayInBackground: true,
          allowsRecording: false,
        });
        player.setActiveForLockScreen(true, { title: episode.title, artist: episode.show.title });
        player.play();
        update({ ...current.current, playing: true });
      } catch {
        setError('Audio could not start. Try again.');
      }
    };
    const seek = (positionMs: number) => {
      const next = moveRadio(episode, current.current, positionMs);
      update(next);
      if (next.activeQuestionId) player.pause();
      void player.seekTo(next.positionMs / 1000).catch(() => setError('Could not move playback.'));
    };
    const question = episode.questions.find((q) => q.id === state.activeQuestionId);
    const answer = (value: NarrativeAnswer) => {
      const next = answerRadio(episode, current.current, value);
      if (next.answers.length > current.current.answers.length)
        props.onAttempt(next.answers.at(-1)!, next);
      update(next);
    };
    const complete = async () => {
      const result = completeRadio(episode, current.current, true);
      if (!result.canCommit || finished) return;
      setFinished(true);
      try {
        await props.onComplete(result, current.current);
      } catch {
        setFinished(false);
        setError('Could not save this episode. Try again.');
      }
    };
    if (!props.audioAvailable || !episode.bakedAudioComplete)
      return (
        <View style={styles.screen}>
          <Text style={styles.title}>Audio unavailable</Text>
          <Text style={styles.text}>
            Repair this episode’s audio to listen. You can continue on the path.
          </Text>
          <MediaButton label="Repair audio" onPress={props.onRepair} />
          <MediaButton label="Back to path" secondary onPress={props.onClose} />
        </View>
      );
    return (
      <View style={styles.screen} testID="radio-player">
        <View style={styles.top}>
          <MediaButton
            label="Close episode"
            secondary
            onPress={() => {
              player.pause();
              save({ ...current.current, playing: false });
              props.onClose();
            }}
          >
            ×
          </MediaButton>
          <Progress value={state.positionMs / episode.audio.durationMs} label="Episode progress" />
        </View>
        <View style={styles.center}>
          <Text style={styles.label}>{episode.show.title.toUpperCase()}</Text>
          <Text style={styles.title}>{episode.title}</Text>
          <Text
            style={styles.text}
          >{`${Math.floor(state.positionMs / 60000)}:${String(Math.floor(state.positionMs / 1000) % 60).padStart(2, '0')}`}</Text>
        </View>
        <View style={styles.row}>
          <MediaButton
            label="Rewind 5 seconds"
            secondary
            onPress={() => seek(state.positionMs - RADIO_REWIND_MS)}
          />
          <MediaButton
            label={state.playing ? 'Pause episode' : 'Play episode'}
            disabled={!!question}
            onPress={() => {
              if (state.playing) {
                player.pause();
                update({ ...current.current, playing: false });
              } else void play();
            }}
          />
        </View>
        <MediaButton
          label={transcript ? 'Hide Transcript' : 'View Transcript'}
          secondary
          onPress={() => showTranscript(!transcript)}
        />
        {transcript && (
          <ScrollView style={styles.scroll}>
            {episode.segments.map((segment) => (
              <Text key={segment.id} style={styles.text}>
                {segment.text}
              </Text>
            ))}
          </ScrollView>
        )}
        {question && <RadioQuestionCard key={question.id} question={question} onAnswer={answer} />}
        {error && (
          <Text accessibilityRole="alert" style={[styles.text, styles.error]}>
            {error}
          </Text>
        )}
        {state.positionMs >= episode.audio.durationMs && !question && (
          <View style={styles.card}>
            <Text style={styles.title}>Review the episode</Text>
            <Text style={styles.text}>{`${state.answers.length} questions answered`}</Text>
            <MediaButton
              label={finished ? 'Saved' : 'Finish episode'}
              disabled={finished || !foreground}
              onPress={() => void complete()}
            />
          </View>
        )}
      </View>
    );
  },
);
