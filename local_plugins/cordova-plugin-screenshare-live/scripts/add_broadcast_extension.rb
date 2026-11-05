# Ajoute (ou met à jour) la Broadcast Upload Extension « ScreenShareBroadcast » dans le projet
# Xcode généré par Cordova. Idempotent : relancé à chaque `cordova prepare ios`.
# Usage : ruby add_broadcast_extension.rb <platforms/ios> <src/ios/BroadcastExtension>
require 'xcodeproj'
require 'fileutils'

ios_dir, src_dir = ARGV
NAME = 'ScreenShareBroadcast'.freeze
BUNDLE_ID = 'com.callapp.terminal.ScreenShareBroadcast'.freeze
FILES = %w[SampleHandler.h SampleHandler.m Info.plist ScreenShareBroadcast.entitlements].freeze

# Toujours recopier les sources : les modifications du plugin sont reprises à chaque prepare
ext_dir = File.join(ios_dir, NAME)
FileUtils.mkdir_p(ext_dir)
FILES.each { |f| FileUtils.cp(File.join(src_dir, f), File.join(ext_dir, f)) }

project = Xcodeproj::Project.open(File.join(ios_dir, 'App.xcodeproj'))
app = project.native_targets.find { |t| t.product_type == 'com.apple.product-type.application' }
abort('[ScreenShareLive] Target application introuvable') unless app

if project.targets.any? { |t| t.name == NAME }
  puts "[ScreenShareLive] Extension #{NAME} déjà présente"
  exit 0
end

ext = project.new_target(:app_extension, NAME, :ios, '13.0', nil, :objc)

group = project.main_group.find_subpath(NAME, true)
group.set_source_tree('<group>')
group.set_path(NAME)
FILES.each { |f| group.new_reference(f) }
ext.add_file_references([group.files.find { |r| r.path == 'SampleHandler.m' }])
%w[ReplayKit CoreImage CoreMedia CoreVideo UIKit].each { |fw| ext.add_system_framework(fw) }

app_settings = app.build_configurations.first.build_settings
team = app.build_configurations.map { |c| c.build_settings['DEVELOPMENT_TEAM'] }.compact.first

ext.build_configurations.each do |config|
  s = config.build_settings
  s['PRODUCT_BUNDLE_IDENTIFIER'] = BUNDLE_ID
  s['PRODUCT_NAME'] = '$(TARGET_NAME)'
  s['INFOPLIST_FILE'] = "#{NAME}/Info.plist"
  s['GENERATE_INFOPLIST_FILE'] = 'NO'
  s['CODE_SIGN_ENTITLEMENTS'] = "#{NAME}/#{NAME}.entitlements"
  s['CODE_SIGN_STYLE'] = 'Automatic'
  s['DEVELOPMENT_TEAM'] = team if team
  s['IPHONEOS_DEPLOYMENT_TARGET'] = '13.0'
  s['TARGETED_DEVICE_FAMILY'] = '1,2'
  s['SKIP_INSTALL'] = 'YES'
  s['CLANG_ENABLE_OBJC_ARC'] = 'YES'
  s['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
  # La version de l'extension doit être celle de l'app
  s['MARKETING_VERSION'] = app_settings['MARKETING_VERSION'] || '1.0.0'
  s['CURRENT_PROJECT_VERSION'] = app_settings['CURRENT_PROJECT_VERSION'] || '1'
  s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
end

attributes = project.root_object.attributes['TargetAttributes'] ||= {}
attributes[ext.uuid] = { 'CreatedOnToolsVersion' => '15.0', 'ProvisioningStyle' => 'Automatic' }
attributes[ext.uuid]['DevelopmentTeam'] = team if team

# L'app embarque l'extension dans CallApp.app/PlugIns
app.add_dependency(ext)
embed = app.copy_files_build_phases.find { |p| p.name == 'Embed App Extensions' } ||
        app.new_copy_files_build_phase('Embed App Extensions')
embed.symbol_dst_subfolder_spec = :plug_ins
build_file = embed.add_file_reference(ext.product_reference, true)
build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }

project.save
puts "[ScreenShareLive] Extension #{NAME} ajoutée (#{BUNDLE_ID})"
