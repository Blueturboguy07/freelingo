from pathlib import Path
import os,subprocess,sys,shutil
root=Path(__file__).parent
cache=Path(os.environ.get('GRADLE_USER_HOME',str(Path.home()/'.gradle')))/'caches/modules-2/files-2.1'
def jar(group,name,version): return next((cache/group/name/version).glob('*/*.jar'))
compiler=[jar('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.1.20'),jar('org.jetbrains.kotlin','kotlin-stdlib','2.1.20'),jar('org.jetbrains.kotlin','kotlin-script-runtime','2.1.20'),jar('org.jetbrains.kotlin','kotlin-reflect','2.1.20'),jar('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'),next((cache/'org.jetbrains/annotations').glob('*/*/*.jar'))]
compiler.append(next((cache/'org.jetbrains.intellij.deps/trove4j').glob('*/*/*.jar')))
java=str(Path(os.environ['JAVA_HOME'])/'bin/java') if 'JAVA_HOME' in os.environ else shutil.which('java')
if not java: raise SystemExit('Java 17+ is required; run the native build first to populate the Kotlin compiler cache.')
source=Path(sys.argv[1])/'android/src/main/java/expo/modules/speech'
if not (source/'SpeechModule.kt').is_file(): raise SystemExit('Expected an installed expo-speech package directory containing SpeechModule.kt.')
out=Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
cp=':'.join(map(str,compiler))
files=list(source.glob('*.kt'))+list((root/'stubs').glob('*.kt'))+[root/'Cases.kt']
subprocess.run([java,'-Xmx768m','-cp',cp,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',cp,'-d',str(out),*map(str,files)],check=True)
subprocess.run([java,'-cp',str(out)+':'+cp,'CasesKt'],check=True)
