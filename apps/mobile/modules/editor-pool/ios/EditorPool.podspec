Pod::Spec.new do |s|
  s.name           = 'EditorPool'
  s.version        = '1.0.0'
  s.summary        = 'Page editors loaded before a page opens, for dohc.'
  s.description    = 'Keeps one WKWebView with the page editor loaded, and hands it to the next page that opens.'
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
