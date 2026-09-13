import subprocess,sys
from pathlib import Path
root=Path(sys.argv[1]);label=sys.argv[2];s=(root/'ios/ExpoSpeechRecognizer.swift').read_text();methods=s[s.index('extension SFSpeechRecognizer {'):]
preamble='''import Foundation
enum SFSpeechRecognizerAuthorizationStatus {case denied, authorized}
class SFSpeechRecognizer { static var prompts=0; static func authorizationStatus()->SFSpeechRecognizerAuthorizationStatus{.denied}; static func requestAuthorization(_ reply:(SFSpeechRecognizerAuthorizationStatus)->Void){prompts+=1;reply(.authorized)} }
enum RecordPermission {case denied,granted}
class AVAudioSession { var recordPermission:RecordPermission = .denied; var prompts=0; func requestRecordPermission(_ reply:(Bool)->Void){prompts+=1;reply(true)} }
'''
trailer='''
@main struct Runner {static func main() async {
 let audio=AVAudioSession();var failures:[String]=[]
 let speech=await SFSpeechRecognizer.hasAuthorizationToRecognize()
 let record=await audio.hasPermissionToRecord()
 if speech || record {failures.append("start helper granted permission that was previously denied")}
 if SFSpeechRecognizer.prompts != 0 || audio.prompts != 0 {failures.append("start helper opened a permission prompt")}
 _ = await SFSpeechRecognizer.requestPermissions()
 if SFSpeechRecognizer.prompts != 1 {failures.append("explicit permission request behavior changed")}
 if !failures.isEmpty {for f in failures{print("FAIL: "+f)};exit(1)}
 print("PASS: exact native helpers read grants without prompting; explicit request remains available")
}}
'''
source=Path(sys.argv[3])/f'p5-native-permission-{label}.swift';source.write_text(preamble+methods+trailer);binary=source.with_suffix('')
r=subprocess.run(['/usr/bin/swiftc','-parse-as-library','-module-cache-path',str(Path(sys.argv[3])/'module-cache'),str(source),'-o',str(binary)])
if r.returncode: raise SystemExit(r.returncode)
r=subprocess.run([str(binary)]);(Path(sys.argv[3])/f'p5-native-permission-{label}.exit').write_text(str(r.returncode));raise SystemExit(r.returncode)
