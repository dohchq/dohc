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
        self.stream
            .set_write_timeout(timeout.not_zero().map(|t| *t))?;
        self.stream
            .write_all(&self.buffers.output()[..amount])
            .map_err(|e| io_error(e, timeout))
    }

    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, Error> {
        self.stream
            .set_read_timeout(timeout.not_zero().map(|t| *t))?;
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
