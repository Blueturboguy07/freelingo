Pod::Spec.new do |s|
  s.name = 'WidgetPublication'
  s.version = '0.1.0'
  s.summary = 'Atomic local widget publication and WidgetKit reloads for Freelingo'
  s.description = 'Shares the committed widget snapshot and reload budget with the app-group target.'
  s.author = 'Freelingo contributors'
  s.homepage = 'https://github.com/Blueturboguy07/freelingo'
  s.license = { :type => 'AGPL-3.0' }
  s.source = { :git => 'https://github.com/Blueturboguy07/freelingo.git', :tag => s.version.to_s }
  s.platforms = { :ios => '16.4' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Foundation', 'WidgetKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
  # The config plugin adds the extension to its own target, never to the app pod.
  s.exclude_files = 'WidgetExtension/**/*'
end
