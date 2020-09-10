AAC = require "../src/streammachine/parsers/aac"
_ = require "underscore"

aac = new AAC

firstHeader = null
headerCount = 0

ema_alpha = 2 / (40+1)
ema = null

aac.on "frame", (buf,header) =>
    headerCount += 1

    bitrate = header.frame_length / header.duration * 1000 * 8

    ema ||= bitrate
    ema = ema_alpha * bitrate + (1-ema_alpha) * ema

    console.log "header #{headerCount}: #{bitrate} (#{Math.round(ema / 1000)})"

    return true
    if firstHeader
        if _.isEqual(firstHeader,obj)
            # do nothing
        else
            console.log "Header #{headerCount}: ", obj

    else
        firstHeader = obj
        console.log "First header: ", obj

process.stdin.pipe aac