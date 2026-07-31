#import <AppKit/AppKit.h>
#import <CoreImage/CoreImage.h>
#import <Foundation/Foundation.h>

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 2) return 1;
        NSData *input = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
        if (input.length == 0) return 2;
        CIFilter *filter = [CIFilter filterWithName:@"CIQRCodeGenerator"];
        [filter setValue:input forKey:@"inputMessage"];
        [filter setValue:@"M" forKey:@"inputCorrectionLevel"];
        CIImage *image = [[filter outputImage]
            imageByApplyingTransform:CGAffineTransformMakeScale(8.0, 8.0)];
        CIContext *context = [CIContext contextWithOptions:nil];
        CGImageRef cgImage = [context createCGImage:image fromRect:image.extent];
        if (cgImage == NULL) return 3;
        NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:cgImage];
        CGImageRelease(cgImage);
        NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (png == nil) return 4;
        NSString *path = [NSString stringWithUTF8String:argv[1]];
        return [png writeToFile:path atomically:YES] ? 0 : 5;
    }
}
