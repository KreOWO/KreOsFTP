package com.kreos.ftp.protocol

import com.kreos.ftp.model.Protocol
import com.kreos.ftp.model.SiteProfile

object RemoteClientFactory {
    fun create(profile: SiteProfile): RemoteClient = when (profile.protocol) {
        Protocol.FTP, Protocol.FTPS -> FtpRemoteClient(profile)
        Protocol.SFTP -> SftpRemoteClient(profile)
    }
}
