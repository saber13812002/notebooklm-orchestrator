# NLO — http-context snippet (ONE-TIME install, main nginx.conf inside `http { }`)
#
# Required by nlo-vhost.stageB.conf.tpl for WebSocket/SSE upgrade passthrough.
# If the webserver main config already defines `$connection_upgrade`, do not
# duplicate it. Render nothing (no placeholders); copy verbatim.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
