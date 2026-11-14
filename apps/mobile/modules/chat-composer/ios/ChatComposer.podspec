Pod::Spec.new do |s|
  s.name           = 'ChatComposer'
  s.version        = '1.0.0'
  s.summary        = 'The chat composer\'s native multiline text field, for dohc.'
  s.description    = 'A UITextView at the body text size with Dynamic Type, which reports its text and height and clears only the text it was asked to.'
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
