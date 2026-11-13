Pod::Spec.new do |s|
  s.name           = 'DurableFile'
  s.version        = '1.0.0'
  s.summary        = 'Keeps the phone outbox\'s records on disk through a closed app, a restart and power loss, for dohc.'
  s.description    = 'Writes each record to a temporary file, syncs it, renames it over the record and syncs the folder.'
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
