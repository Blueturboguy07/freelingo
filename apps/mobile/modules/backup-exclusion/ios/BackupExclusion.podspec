Pod::Spec.new do |s|
  s.name           = 'BackupExclusion'
  s.version        = '1.0.0'
  s.summary        = 'Backup exclusion for the Freelingo pack cache (INV-PACK-11)'
  s.description    = 'Sets NSURLIsExcludedFromBackupKey on iOS; on Android exclusion is declared statically by the config plugin.'
  s.author         = ''
  s.homepage       = 'https://github.com/Blueturboguy07/freelingo'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
