Pod::Spec.new do |s|
  s.name           = 'DurableFile'
  s.version        = '1.0.0'
  s.summary        = 'Prepares the folder that holds the dohc phone app\'s kept.db.'
  s.description    = 'Creates the folder, excludes it from backup, protects it until the first unlock, and syncs it.'
  s.license        = 'UNLICENSED'
  s.author         = 'dohc'
  s.homepage       = 'https://dohc.app'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.swift"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
