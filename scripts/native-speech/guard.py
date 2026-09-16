import re, subprocess, sys
from pathlib import Path
root=Path(sys.argv[1]); label=sys.argv[2]
p=root/'ios/ExpoSpeechRecognizer.swift'
s=p.read_text();start=s.index('  private static func prepareRequest(');end=s.index('\n  private static func setupAudioSession',start)
method=s[start:end].replace('private static func','static func',1)
preamble='''import Foundation
struct SpeechRecognitionOptions { var interimResults=false; var continuous=true; var requiresOnDeviceRecognition=true; var iosTaskHint:TaskHint?=nil; var contextualStrings:[String]?=nil; var addsPunctuation=false }
struct TaskHint { var sfSpeechRecognitionTaskHint=0 }
class SFSpeechRecognizer { let supportsOnDeviceRecognition:Bool; init(_ supports:Bool){supportsOnDeviceRecognition=supports} }
class SFSpeechRecognitionRequest { var shouldReportPartialResults=false; var requiresOnDeviceRecognition=false; var taskHint=0; var contextualStrings:[String]=[]; var addsPunctuation=false }
class SFSpeechAudioBufferRecognitionRequest:SFSpeechRecognitionRequest { static var allocations=0; override init(){Self.allocations+=1;super.init()} }
enum RecognizerError:Error { case recognizerIsUnavailable }
struct Probe {
'''
trailer='''
}
var failures:[String]=[]
do { _ = try Probe.prepareRequest(options:SpeechRecognitionOptions(),recognizer:SFSpeechRecognizer(false)); failures.append("unsupported requested locale silently accepted") } catch {}
if SFSpeechAudioBufferRecognitionRequest.allocations != 0 { failures.append("audio request allocated before unsupported-locale refusal") }
do { let request=try Probe.prepareRequest(options:SpeechRecognitionOptions(),recognizer:SFSpeechRecognizer(true)); if !request.requiresOnDeviceRecognition { failures.append("supported locale did not force local recognition") } } catch { failures.append("supported recognizer rejected") }
if !failures.isEmpty { for message in failures { print("FAIL: "+message) }; exit(1) }
print("PASS: exact native prepareRequest rejects unsupported locale before allocation and forces on-device for supported locale")
'''
source=Path(sys.argv[3])/f'p5-native-guard-{label}.swift';source.write_text(preamble+method+trailer)
binary=source.with_suffix('')
r=subprocess.run(['/usr/bin/swiftc','-module-cache-path',str(Path(sys.argv[3])/'module-cache'),str(source),'-o',str(binary)])
if r.returncode: raise SystemExit(r.returncode)
r=subprocess.run([str(binary)])
(Path(sys.argv[3])/f'p5-native-guard-{label}.exit').write_text(str(r.returncode)); raise SystemExit(r.returncode)
