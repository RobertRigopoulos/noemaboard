import { Config } from '@remotion/cli/config'

Config.setVideoImageFormat('jpeg')
Config.setJpegQuality(95)
Config.setOverwriteOutput(true)
// The usual settings for HD video, so social sites show the colours as rendered.
Config.setPixelFormat('yuv420p')
Config.setColorSpace('bt709')
