Pod::Spec.new do |s|
  s.name           = 'BarBand'
  s.version        = '1.0.0'
  s.summary        = 'Holds a list and the band drawn under the navigation bar over it, for dohc.'
  s.description    = 'Tells iOS the band covers a strip, keeps the band at the bar\'s bottom, and sets VoiceOver\'s order. Draws nothing.'
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
