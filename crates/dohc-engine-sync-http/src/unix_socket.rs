use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
};
use ureq::{
    Error,
    unversioned::transport::{
        Buffers, ConnectionDetails, Connector, LazyBuffers, NextTimeout, Transport,
    },
};

#[derive(Debug)]
pub(super) struct UnixResolver;

impl ureq::unversioned::resolver::Resolver for UnixResolver {
    fn resolve(
        &self,
        uri: &ureq::http::Uri,
        _: &ureq::config::Config,
        _: NextTimeout,
    ) -> Result<ureq::unversioned::resolver::ResolvedSocketAddrs, Error> {
        if uri.scheme_str() != Some("http")
            || uri.authority().map(|a| a.as_str()) != Some("127.0.0.1")
        {
            return Err(Error::HostNotFound);
        }
        let mut addresses = self.empty();
        addresses.push(std::net::SocketAddr::from(([127, 0, 0, 1], 80)));
        Ok(addresses)
    }
}

#[derive(Debug)]
pub(super) struct UnixConnector(pub PathBuf);

impl Connector for UnixConnector {
    type Out = UnixTransport;

    fn connect(
        &self,
        details: &ConnectionDetails,
        _: Option<()>,
    ) -> Result<Option<Self::Out>, Error> {
        if details.uri.scheme_str() != Some("http")
            || details.uri.authority().map(|a| a.as_str()) != Some("127.0.0.1")
        {
            return Err(Error::ConnectionFailed);
        }
        Ok(Some(UnixTransport {
            stream: UnixStream::connect(&self.0)?,
            buffers: LazyBuffers::new(
                details.config.input_buffer_size(),
                details.config.output_buffer_size(),
            ),
        }))
    }
}

#[derive(Debug)]
pub(super) struct UnixTransport {
    stream: UnixStream,
    buffers: LazyBuffers,
}

/// macOS refuses socket options once the peer has closed, yet buffered bytes
/// and EOF still read, and a write still reports the closed peer. Only the
/// kernel's EINVAL is ignored: std's own zero-duration error carries no OS
/// code, and the request timeout bounds every duration to 30 s, so an
/// out-of-range value never reaches the kernel.
fn set_timeout(result: std::io::Result<()>) -> Result<(), Error> {
    match result {
        Err(error)
            if cfg!(target_vendor = "apple")
                && error.kind() == std::io::ErrorKind::InvalidInput
                && error.raw_os_error().is_some() =>
        {
            Ok(())
        }
        result => Ok(result?),
    }
}

fn io_error(error: std::io::Error, timeout: NextTimeout) -> Error {
    if matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
    ) {
        Error::Timeout(timeout.reason)
    } else {
        error.into()
    }
}

impl Transport for UnixTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }

    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), Error> {
        set_timeout(
            self.stream
                .set_write_timeout(timeout.not_zero().map(|t| *t)),
        )?;
        self.stream
            .write_all(&self.buffers.output()[..amount])
            .map_err(|e| io_error(e, timeout))
    }

    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, Error> {
        set_timeout(self.stream.set_read_timeout(timeout.not_zero().map(|t| *t)))?;
        let amount = self
            .stream
            .read(self.buffers.input_append_buf())
            .map_err(|e| io_error(e, timeout))?;
        self.buffers.input_appended(amount);
        Ok(amount > 0)
    }

    fn is_open(&mut self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_response_the_peer_already_closed() {
        let (stream, mut peer) = UnixStream::pair().unwrap();
        peer.write_all(b"HTTP/1.1 200 OK\r\n\r\n").unwrap();
        drop(peer);
        let mut transport = UnixTransport {
            stream,
            buffers: LazyBuffers::new(1024, 1024),
        };
        let timeout = NextTimeout {
            after: std::time::Duration::from_secs(5).into(),
            reason: ureq::Timeout::RecvResponse,
        };
        assert!(transport.await_input(timeout).unwrap());
        assert_eq!(transport.buffers.input(), b"HTTP/1.1 200 OK\r\n\r\n");
        assert!(!transport.await_input(timeout).unwrap());
    }
}
