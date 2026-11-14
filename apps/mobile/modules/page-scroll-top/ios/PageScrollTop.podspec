Pod::Spec.new do |s|
  s.name           = 'PageScrollTop'
  s.version        = '1.0.0'
  s.summary        = 'Holds a page\'s web view so a status-bar tap scrolls the page to its top, for dohc.'
  s.description    = 'Takes the status-bar tap from the web view\'s scroll views and passes it to the page. Draws nothing.'
  s.license        = 'UNLICENSED'
  s.author         = 'dohc'
  s.homepage       = 'https://dohc.app'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'WebKit'

  s.source_files = "**/*.swift"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
